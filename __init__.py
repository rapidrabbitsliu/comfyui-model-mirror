"""ComfyUI extension routes for explicitly requested model downloads."""
from aiohttp import web
from server import PromptServer

from .download import download, ModelDownloadError

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}


@PromptServer.instance.routes.post("/model-mirror/download")
async def download_model(request):
    if request.content_type != "application/json":
        raise web.HTTPUnsupportedMediaType()
    try:
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError("Expected a JSON object")
        result = await download(data)
    except (ValueError, ModelDownloadError) as error:
        return web.json_response({"error": str(error)}, status=400)
    return web.json_response(result)
