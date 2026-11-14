import { app } from "/scripts/app.js";

const rowDownloadControl = '[data-testid="missing-model-download"]';
const rowControls = `${rowDownloadControl}, [data-testid="missing-model-locate"]`;
const downloadAllControl = '[data-testid="missing-model-download-all"]';
const downloadControls = `${rowDownloadControl}, ${downloadAllControl}`;
const actionsSelector = '[data-testid="missing-model-actions"]';
const rowsSelector = '[data-testid="missing-model-importable-rows"]';
const preferenceKey = "comfyui-model-mirror.enabled";
const hfUrl = /^https:\/\/(huggingface\.co|hf\.co|hf-mirror\.com)\//i;

function rowProps(button) {
    for (let element = button; element; element = element.parentElement) {
        for (let component = element.__vueParentComponent; component; component = component.parent) {
            if (component.props?.model?.representative) return component.props;
        }
    }
}

function rowModel(control) {
    const representative = rowProps(control)?.model.representative;
    if (representative) return representative;
    const row = control.closest(".min-h-8");
    const name = row?.querySelector("span.min-w-0.flex-1 [title]")?.title;
    if (!name) return;
    const workflow = app.graph.serialize();
    const candidates = [];
    function collect(graph) {
        for (const model of graph.models ?? []) {
            if (model.name === name && model.directory) candidates.push(model);
        }
        for (const node of graph.nodes ?? []) {
            for (const model of node.properties?.models ?? []) {
                if (model.name === name && model.directory) candidates.push(model);
            }
        }
        for (const subgraph of graph.definitions?.subgraphs ?? []) collect(subgraph);
    }
    collect(workflow);
    const identities = new Set(candidates.map(({ directory, url, hash }) =>
        JSON.stringify([directory, url, hash])
    ));
    if (identities.size === 1) return candidates[0];
}

async function download(model, url, requestId) {
    const response = await fetch("/model-mirror/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            url, name: model.name, directory: model.directory, request_id: requestId,
            sha256: model.hashType?.toLowerCase() === "sha256" ? model.hash : undefined,
        }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
}

function formatBytes(bytes) {
    let unit = 0;
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    while (bytes >= 1024 && unit < units.length - 1) {
        bytes /= 1024;
        unit++;
    }
    return `${bytes.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatTime(seconds) {
    const whole = Math.max(0, Math.ceil(seconds));
    const minutes = Math.floor(whole / 60);
    const clock = [minutes % 60, whole % 60].map(value => String(value).padStart(2, "0")).join(":");
    return minutes >= 60 ? `${Math.floor(minutes / 60)}:${clock}` : clock;
}

async function downloadWithProgress(model, url, status, button) {
    const id = crypto.randomUUID();
    const start = performance.now();
    let current = { bytes: 0, total: null };
    let samples = [{ time: start, bytes: 0 }];
    let pending = false;
    let done = false;

    const render = () => {
        const now = performance.now();
        samples.push({ time: now, bytes: current.bytes });
        samples = samples.filter(sample => now - sample.time <= 6000);
        const past = samples[0];
        const speed = now > past.time ? (current.bytes - past.bytes) * 1000 / (now - past.time) : 0;
        const size = current.total
            ? `${formatBytes(current.bytes)} / ${formatBytes(current.total)} · ${Math.floor(100 * current.bytes / current.total)}%`
            : formatBytes(current.bytes);
        const eta = current.total && speed > 0 && current.bytes < current.total
            ? formatTime((current.total - current.bytes) / speed)
            : "—";
        if (current.total) {
            button.style.setProperty("--model-mirror-progress", `${Math.min(100, 100 * current.bytes / current.total)}%`);
        }
        status.textContent = `${model.name} · ${size} · ${formatBytes(speed)}/s · 已用 ${formatTime((now - start) / 1000)} · 预计剩余 ${eta}`;
    };

    const tick = async () => {
        if (pending) {
            render();
            return;
        }
        pending = true;
        try {
            const response = await fetch(`/model-mirror/progress/${id}`, {
                cache: "no-store",
                signal: AbortSignal.timeout(5000),
            });
            if (response.ok) current = await response.json() ?? current;
        } catch {
            // The download request reports transfer errors separately.
        } finally {
            pending = false;
            if (!done) render();
        }
    };

    render();
    const timer = setInterval(tick, 1000);
    try {
        await download(model, url, id);
    } finally {
        done = true;
        clearInterval(timer);
        button.style.removeProperty("--model-mirror-progress");
    }
}

async function downloadWithFallback(model, status, button, batch = false) {
    const mirrorUrl = hfUrl.test(model.url || "") ? model.url : "";
    let url = mirrorUrl;
    for (;;) {
        let reason = "工作流没有提供 Hugging Face 文件链接。";
        if (url) {
            try {
                await downloadWithProgress(model, url, status, button);
                return "downloaded";
            } catch (error) {
                reason = error.message;
            }
        }
        status.textContent = `${model.name} · 等待选择下载来源`;
        const choice = window.prompt([
            `${model.name}：${reason}`,
            ...(mirrorUrl ? ["1 重试 HF-Mirror"] : []),
            "2 在魔搭搜索模型",
            "3 粘贴文件直链",
            ...(batch ? ["4 跳过此模型，继续下载"] : []),
            batch ? "取消即停止批量下载" : "取消即停止",
        ].join("\n"));
        if (choice === "1" && mirrorUrl) {
            url = mirrorUrl;
        } else if (choice === "2") {
            window.open(
                `https://modelscope.cn/search?search=${encodeURIComponent(model.name.split("/").pop())}`,
                "_blank", "noopener,noreferrer"
            );
            url = window.prompt("核对仓库、版本和精度后，粘贴魔搭文件直链。");
            if (!url) return "stopped";
        } else if (choice === "3") {
            url = window.prompt("粘贴 HF-Mirror 或魔搭文件直链。");
            if (!url) return "stopped";
        } else {
            return batch && choice === "4" ? "skipped" : "stopped";
        }
    }
}

// Only restore controls that the extension disabled.
let lockedButtons;

function lockDownloadButtons() {
    for (const button of document.querySelectorAll(`${downloadControls}, [data-model-mirror-switch] input`)) {
        if (button.disabled) continue;
        button.disabled = true;
        lockedButtons.add(button);
    }
}

async function withDownloadState(button, task) {
    lockedButtons = new Set();
    lockDownloadButtons();
    const overlay = document.createElement("span");
    overlay.className = "model-mirror-loading";
    overlay.setAttribute("aria-hidden", "true");
    const caption = document.createElement("span");
    caption.textContent = "下载中…";
    overlay.append(caption);
    button.append(overlay);
    button.setAttribute("aria-busy", "true");
    const anchor = button.closest(`${actionsSelector}, .min-h-8`) ?? button;
    const previous = anchor.nextElementSibling;
    if (previous?.hasAttribute("data-model-mirror-status")) previous.remove();
    const status = document.createElement("div");
    status.dataset.modelMirrorStatus = "";
    status.className = "break-all px-1 py-1 text-xs text-muted-foreground";
    anchor.after(status);
    try {
        await task(caption, status);
    } catch (error) {
        status.textContent = `下载失败 · ${error.message}`;
    } finally {
        if (!status.textContent) status.remove();
        overlay.remove();
        button.removeAttribute("aria-busy");
        for (const control of lockedButtons) control.disabled = false;
        lockedButtons = null;
    }
}

function batchModels(button) {
    const card = button.closest(actionsSelector)?.parentElement;
    const models = new Map();
    const unresolved = new Set();
    for (const control of card?.querySelectorAll(rowControls) ?? []) {
        const model = rowModel(control);
        if (model?.directory) {
            models.set(JSON.stringify([model.directory, model.name]), model);
        } else {
            unresolved.add(control.closest(".min-h-8") ?? control);
        }
    }
    return { models: [...models.values()], unresolved: unresolved.size };
}

async function downloadBatch(button, caption, status) {
    const { models, unresolved } = batchModels(button);
    if (!models.length) {
        window.alert("无法读取缺失模型的名称和目录。");
        return;
    }
    let downloaded = 0;
    let skipped = 0;
    for (const [index, model] of models.entries()) {
        caption.textContent = `下载中 ${index + 1}/${models.length}`;
        const result = await downloadWithFallback(model, status, button, true);
        if (result === "stopped") break;
        if (result === "downloaded") downloaded++;
        if (result === "skipped") skipped++;
    }
    const remaining = models.length - downloaded - skipped;
    const summary = [`已下载 ${downloaded} 个`];
    if (skipped) summary.push(`已跳过 ${skipped} 个`);
    if (remaining) summary.push(`未完成 ${remaining} 个`);
    if (unresolved) summary.push(`无法读取目录的模型行 ${unresolved} 个`);
    status.textContent = summary.join("，") + (downloaded ? "。请刷新缺失模型列表。" : "。");
}

let mirrorEnabled = localStorage.getItem(preferenceKey) !== "false";

function addMirrorSwitch(rows) {
    let label = rows.previousElementSibling;
    if (!label?.hasAttribute("data-model-mirror-switch")) label = null;
    if (label) {
        label.firstElementChild.checked = mirrorEnabled;
        return;
    }
    label = document.createElement("label");
    label.dataset.modelMirrorSwitch = "";
    label.className = "mb-2 flex items-center gap-1.5 text-xs";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("role", "switch");
    input.checked = mirrorEnabled;
    input.addEventListener("change", () => {
        mirrorEnabled = input.checked;
        localStorage.setItem(preferenceKey, String(mirrorEnabled));
        for (const other of document.querySelectorAll("[data-model-mirror-switch] input")) {
            other.checked = mirrorEnabled;
        }
    });
    label.append(input, "使用 HF-Mirror（单项与全部下载）");
    rows.before(label);
}

async function interceptDownload(event) {
    const button = event.target.closest?.(downloadControls);
    if (!button || (!mirrorEnabled && !lockedButtons)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (lockedButtons || button.disabled) return;
    await withDownloadState(button, async (caption, status) => {
        if (button.matches(downloadAllControl)) {
            await downloadBatch(button, caption, status);
            return;
        }
        const model = rowModel(button);
        if (!model?.directory) {
            window.alert("无法读取模型目录，请检查前端版本。");
            return;
        }
        status.textContent = await downloadWithFallback(model, status, button) === "downloaded"
            ? `${model.name} 下载完成，请刷新缺失模型列表。`
            : `${model.name} · 下载已停止`;
    });
}

app.registerExtension({
    name: "Local.ModelMirror",
    setup() {
        const styles = document.createElement("style");
        styles.textContent = `
            @keyframes model-mirror-spin { to { transform: rotate(360deg); } }
            :is([data-testid="missing-model-download"], [data-testid="missing-model-download-all"])[aria-busy="true"] {
                position: relative; min-width: 6em; color: transparent;
            }
            [aria-busy="true"]:has(> .model-mirror-loading) > :not(.model-mirror-loading) { visibility: hidden; }
            .model-mirror-loading {
                position: absolute; inset: 0; display: flex; align-items: center;
                justify-content: center; gap: 0.35em; color: var(--foreground, CanvasText);
                white-space: nowrap;
            }
            .model-mirror-loading::after {
                content: ""; position: absolute; bottom: 0; left: 0; height: 2px;
                width: var(--model-mirror-progress, 0%); background: currentColor;
                transition: width 0.25s ease;
            }
            .model-mirror-loading::before {
                content: ""; width: 0.85em; height: 0.85em;
                border: 2px solid currentColor; border-right-color: transparent;
                border-radius: 50%; animation: model-mirror-spin 0.8s linear infinite;
            }
            @media (prefers-reduced-motion: reduce) {
                .model-mirror-loading::before { animation: none; }
                .model-mirror-loading::after { transition: none; }
            }
        `;
        document.head.append(styles);
        document.addEventListener("click", interceptDownload, true);
        const scan = () => {
            for (const label of document.querySelectorAll("[data-model-mirror-switch]")) {
                if (!label.nextElementSibling?.matches(rowsSelector)) label.remove();
            }
            for (const rows of document.querySelectorAll(rowsSelector)) {
                if (rows.parentElement.querySelector(actionsSelector)) addMirrorSwitch(rows);
            }
            if (lockedButtons) lockDownloadButtons();
        };
        let scheduled = false;
        new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                scan();
            });
        }).observe(document.body, { childList: true, subtree: true });
        scan();
    },
});
