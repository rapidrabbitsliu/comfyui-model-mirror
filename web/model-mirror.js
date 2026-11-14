import { app } from "/scripts/app.js";

const rowControls = '[data-testid="missing-model-download"], [data-testid="missing-model-locate"]';
const downloadAllControl = '[data-testid="missing-model-download-all"]';
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

async function download(model, url) {
    const response = await fetch("/model-mirror/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            url, name: model.name, directory: model.directory,
            sha256: model.hashType?.toLowerCase() === "sha256" ? model.hash : undefined,
        }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
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

async function downloadWithFallback(model, batch = false) {
    const mirrorUrl = hfUrl.test(model.url || "") ? model.url : "";
    let url = mirrorUrl;
    for (;;) {
        let reason = "工作流没有提供 Hugging Face 文件链接。";
        if (url) {
            try {
                await download(model, url);
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

// Serialize downloads so a batch and a row cannot open fallback prompts together.
let downloadInProgress = false;

function onDownload(button, task) {
    button.addEventListener("click", async () => {
        if (downloadInProgress) {
            window.alert("已有模型正在下载，请等待完成。");
            return;
        }
        downloadInProgress = true;
        button.disabled = true;
        const label = button.textContent;
        try {
            await task();
        } finally {
            button.textContent = label;
            button.disabled = false;
            downloadInProgress = false;
        }
    });
}

function attach(original) {
    const button = addButton(original, "HF-Mirror");
    if (!button) return;
    onDownload(button, async () => {
        const model = rowModel(original);
        if (!model?.directory) {
            window.alert("无法读取模型目录，请检查前端版本。");
            return;
        }
        button.textContent = "下载中…";
        if (await downloadWithFallback(model) === "downloaded") {
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
    onDownload(button, async () => {
        const { models, unresolved } = batchModels(original);
        if (!models.length) {
            window.alert("无法读取缺失模型的名称和目录。");
            return;
        }
        let downloaded = 0;
        let skipped = 0;
        for (const [index, model] of models.entries()) {
            button.textContent = `HF-Mirror ${index + 1}/${models.length}`;
            const result = await downloadWithFallback(model, true);
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
        const scan = () => {
            for (const control of document.querySelectorAll(rowControls)) {
                if (!rowModel(control)?.directory) continue;
                if (control.dataset.testid === "missing-model-locate" &&
                    control.closest(".min-h-8")?.querySelector('[data-testid="missing-model-download"]')) continue;
                attach(control);
            }
            for (const control of document.querySelectorAll(downloadAllControl)) attachBatch(control);
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
