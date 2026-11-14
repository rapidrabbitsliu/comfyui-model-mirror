import { app } from "/scripts/app.js";

const rowControls = '[data-testid="missing-model-download"], [data-testid="missing-model-locate"]';
const downloadAllControl = '[data-testid="missing-model-download-all"]';
const hfUrl = /^https:\/\/(huggingface\.co|hf\.co|hf-mirror\.com)\//i;
const allDownloadControls = [
    '[data-testid="missing-model-download"]',
    downloadAllControl,
    "[data-model-mirror]",
].join(", ");

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

async function downloadWithProgress(model, url, status) {
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
        status.textContent = "";
    }
}

function addButton(original, label) {
    if (original.nextElementSibling?.dataset.modelMirror) return;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.modelMirror = "true";
    button.className = "ml-1 shrink-0 rounded border px-2 py-1 text-xs";
    button.textContent = label;
    original.after(button);
    return button;
}

async function downloadWithFallback(model, status, batch = false) {
    const mirrorUrl = hfUrl.test(model.url || "") ? model.url : "";
    let url = mirrorUrl;
    for (;;) {
        let reason = "工作流没有提供 Hugging Face 文件链接。";
        if (url) {
            try {
                await downloadWithProgress(model, url, status);
                return "downloaded";
            } catch (error) {
                reason = error.message;
            }
        }
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
    for (const button of document.querySelectorAll(allDownloadControls)) {
        if (button.disabled) continue;
        button.disabled = true;
        lockedButtons.add(button);
    }
}

function onDownload(button, task) {
    button.addEventListener("click", async () => {
        if (lockedButtons) return;
        lockedButtons = new Set();
        lockDownloadButtons();
        const label = button.textContent;
        const spinner = document.createElement("span");
        spinner.className = "model-mirror-spinner";
        spinner.setAttribute("aria-hidden", "true");
        const caption = document.createElement("span");
        caption.textContent = "下载中…";
        button.replaceChildren(spinner, caption);
        button.setAttribute("aria-busy", "true");
        const status = document.createElement("div");
        status.className = "break-all px-1 py-1 text-xs text-muted-foreground";
        (button.closest('[data-testid="missing-model-actions"], .min-h-8') ?? button).after(status);
        try {
            await task(caption, status);
        } finally {
            status.remove();
            button.textContent = label;
            button.removeAttribute("aria-busy");
            for (const control of lockedButtons) control.disabled = false;
            lockedButtons = null;
        }
    });
}

function attach(original) {
    const button = addButton(original, "HF-Mirror");
    if (!button) return;
    onDownload(button, async (_caption, status) => {
        const model = rowModel(original);
        if (!model?.directory) {
            window.alert("无法读取模型目录，请检查前端版本。");
            return;
        }
        if (await downloadWithFallback(model, status) === "downloaded") {
            window.alert(`${model.name} 下载完成，请刷新缺失模型列表。`);
        }
    });
}

function batchModels(original) {
    const card = original.closest('[data-testid="missing-model-actions"]')?.parentElement;
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

function attachBatch(original) {
    const button = addButton(original, "HF-Mirror 全部下载");
    if (!button) return;
    button.setAttribute("aria-live", "polite");
    onDownload(button, async (caption, status) => {
        const { models, unresolved } = batchModels(original);
        if (!models.length) {
            window.alert("无法读取缺失模型的名称和目录。");
            return;
        }
        let downloaded = 0;
        let skipped = 0;
        for (const [index, model] of models.entries()) {
            caption.textContent = `下载中 ${index + 1}/${models.length}`;
            const result = await downloadWithFallback(model, status, true);
            if (result === "stopped") break;
            if (result === "downloaded") downloaded++;
            if (result === "skipped") skipped++;
        }
        const remaining = models.length - downloaded - skipped;
        const summary = [`已下载 ${downloaded} 个`];
        if (skipped) summary.push(`已跳过 ${skipped} 个`);
        if (remaining) summary.push(`未完成 ${remaining} 个`);
        if (unresolved) summary.push(`无法读取目录的模型行 ${unresolved} 个`);
        window.alert(summary.join("，") + (downloaded ? "。请刷新缺失模型列表。" : "。"));
    });
}

app.registerExtension({
    name: "Local.ModelMirror",
    setup() {
        const styles = document.createElement("style");
        styles.textContent = `
            @keyframes model-mirror-spin { to { transform: rotate(360deg); } }
            .model-mirror-spinner {
                display: inline-block; width: 0.85em; height: 0.85em; margin-right: 0.35em;
                border: 2px solid currentColor; border-right-color: transparent;
                border-radius: 50%; animation: model-mirror-spin 0.8s linear infinite;
            }
            @media (prefers-reduced-motion: reduce) { .model-mirror-spinner { animation: none; } }
        `;
        document.head.append(styles);
        const scan = () => {
            for (const control of document.querySelectorAll(rowControls)) {
                if (!rowModel(control)?.directory) continue;
                if (control.dataset.testid === "missing-model-locate" &&
                    control.closest(".min-h-8")?.querySelector('[data-testid="missing-model-download"]')) continue;
                attach(control);
            }
            for (const control of document.querySelectorAll(downloadAllControl)) attachBatch(control);
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
