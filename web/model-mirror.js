import { app } from "/scripts/app.js";

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

function attach(original) {
    if (original.nextElementSibling?.dataset.modelMirror) return;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.modelMirror = "true";
    button.className = "rounded border px-2 py-1 text-xs";
    button.textContent = "HF-Mirror";
    original.after(button);

    button.addEventListener("click", async () => {
        const model = rowModel(original);
        if (!model?.directory) {
            window.alert("无法读取模型目录，请检查前端版本。");
            return;
        }
        const hf = /^https:\/\/(huggingface\.co|hf\.co|hf-mirror\.com)\//i;
        let url = hf.test(model.url || "") ? model.url : "";
        button.disabled = true;
        button.textContent = "下载中…";
        try {
            for (;;) {
                let reason = "工作流没有提供 Hugging Face 文件链接。";
                if (url) {
                    try {
                        await download(model, url);
                        button.textContent = "已下载，请刷新";
                        return;
                    } catch (error) {
                        reason = error.message;
                    }
                }
                const choice = window.prompt(
                    `${reason}\n1 重试 HF-Mirror\n2 在魔搭搜索模型\n3 粘贴文件直链\n取消即停止`
                );
                if (choice === "1" && hf.test(model.url || "")) {
                    url = model.url;
                } else if (choice === "2") {
                    window.open(
                        `https://modelscope.cn/search?search=${encodeURIComponent(model.name.split("/").pop())}`,
                        "_blank", "noopener,noreferrer"
                    );
                    url = window.prompt("核对仓库、版本和精度后，粘贴魔搭文件直链。也可以取消。");
                    if (!url) break;
                } else if (choice === "3") {
                    url = window.prompt("粘贴 HF-Mirror 或魔搭文件直链。");
                    if (!url) break;
                } else {
                    break;
                }
            }
        } finally {
            button.disabled = false;
            if (button.textContent === "下载中…") button.textContent = "HF-Mirror";
        }
    });
}

app.registerExtension({
    name: "Local.ModelMirror",
    setup() {
        const scan = () => {
            const controls = document.querySelectorAll(
                '[data-testid="missing-model-download"], [data-testid="missing-model-locate"]'
            );
            for (const control of controls) {
                if (!rowModel(control)?.directory) continue;
                if (control.dataset.testid === "missing-model-locate" &&
                    control.closest(".min-h-8")?.querySelector('[data-testid="missing-model-download"]')) continue;
                attach(control);
            }
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
