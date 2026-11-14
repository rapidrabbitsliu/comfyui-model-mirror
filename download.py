import asyncio
import hashlib
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit

import aiohttp
import folder_paths

MIRROR = "hf-mirror.com"
MODELSCOPE = {"modelscope.cn", "www.modelscope.cn"}
SOURCE_HOSTS = {"huggingface.co", "hf.co", MIRROR} | MODELSCOPE
REDIRECT_SUFFIXES = (".hf-mirror.com", ".modelscope.cn", ".modelscope-cdn.cn",
                     ".hf.co", ".huggingface.co", ".aliyuncs.com")
active = set()


class ModelDownloadError(Exception):
    pass


def checked_url(url, redirect=False):
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    allowed = host in (SOURCE_HOSTS if not redirect else ({MIRROR} | MODELSCOPE))
    if redirect:
        allowed |= host.endswith(REDIRECT_SUFFIXES)
    if (not allowed or parsed.scheme != "https" or parsed.username is not None
            or parsed.port not in (443, None) or host in {"huggingface.co", "hf.co"} and redirect):
        raise ValueError("Unsupported download host or URL")
    return parsed


def source_url(url):
    parsed = checked_url(url)
    parts = parsed.path.split("/")
    if parsed.hostname in {"huggingface.co", "hf.co", MIRROR}:
        if len(parts) < 6 or parts[3] not in {"blob", "resolve"}:
            raise ValueError("Expected a Hugging Face model file URL with a revision")
        parts[3] = "resolve"
        return urlunsplit(("https", MIRROR, "/".join(parts), parsed.query, ""))
    if len(parts) < 7 or parts[4] != "resolve" or parts[1] != "models":
        raise ValueError("Paste a ModelScope file link using /models/…/resolve/…")
    return parsed.geturl()


def destination(category, name):
    if not isinstance(category, str) or category not in folder_paths.folder_names_and_paths:
        raise ValueError("Unknown ComfyUI model category")
    if not isinstance(name, str) or not name or "\\" in name or ":" in name:
        raise ValueError("Invalid model filename")
    parts = name.split("/")
    if any(part in ("", ".", "..") or "\0" in part for part in parts):
        raise ValueError("Invalid model filename")
    if Path(parts[-1]).suffix.lower() not in folder_paths.supported_pt_extensions | {".gguf"}:
        raise ValueError("Unsupported model file extension")
    models = Path(folder_paths.models_dir).resolve()
    for directory in folder_paths.get_folder_paths(category):
        root = Path(directory).resolve()
        target = root.joinpath(*parts).resolve()
        if root.is_relative_to(models) and root != models and target.is_relative_to(root):
            return target
    raise ValueError("No model folder under the ComfyUI models directory")


async def open_file(session, url):
    for _ in range(8):
        checked_url(url, redirect=True)
        response = await session.get(url, allow_redirects=False)
        if response.status in {301, 302, 303, 307, 308}:
            location = response.headers.get("Location")
            response.release()
            if not location:
                break
            url = urljoin(url, location)
            continue
        return response
    raise ModelDownloadError("Download redirect did not resolve")


async def download(data):
    raw_url = data.get("url")
    if not isinstance(raw_url, str):
        raise ValueError("A model file URL is required")
    digest = data.get("sha256") or ""
    if not isinstance(digest, str) or digest and not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
        raise ValueError("Invalid SHA-256")
    target = destination(data.get("directory"), data.get("name"))
    url = source_url(raw_url)
    if unquote(urlsplit(url).path.rsplit("/", 1)[-1]) != target.name:
        raise ValueError("The download filename differs from the workflow model")
    if target.exists() or target in active:
        raise ModelDownloadError("The file already exists or is being downloaded")
    active.add(target)
    temp = None
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        timeout = aiohttp.ClientTimeout(total=None, connect=20, sock_read=60)
        async with aiohttp.ClientSession(timeout=timeout, auto_decompress=False) as session:
            async with await open_file(session, url) as response:
                if response.status != 200:
                    raise ModelDownloadError(f"{urlsplit(url).hostname} returned HTTP {response.status}")
                if response.content_type in {"text/html", "application/json", "text/plain"}:
                    raise ModelDownloadError("The source returned a page instead of a model file")
                sha = hashlib.sha256()
                total = 0
                with tempfile.NamedTemporaryFile(dir=target.parent, suffix=".part", delete=False) as output:
                    temp = Path(output.name)
                    async for chunk in response.content.iter_chunked(1024 * 1024):
                        output.write(chunk)
                        sha.update(chunk)
                        total += len(chunk)
                if not total or response.content_length not in (total, None):
                    raise ModelDownloadError("Incomplete download")
                if digest and sha.hexdigest() != digest.lower():
                    raise ModelDownloadError("SHA-256 mismatch")
                os.link(temp, target)
        folder_paths.filename_list_cache.pop(data["directory"], None)
        return {"name": data["name"], "bytes": total, "sha256": sha.hexdigest()}
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as error:
        raise ModelDownloadError(f"Download failed ({type(error).__name__})") from error
    finally:
        active.discard(target)
        if temp is not None:
            temp.unlink(missing_ok=True)
