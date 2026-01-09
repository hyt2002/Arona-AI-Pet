import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { loadSettings, saveSettings, DEFAULT_SETTINGS, type Settings } from "./settingsStore";

// DOM 元素
let screenHeightRatioInput: HTMLInputElement;
let paddingInput: HTMLInputElement;
let fpsLimitInput: HTMLInputElement;
let dragWRatioInput: HTMLInputElement;
let dragHRatioInput: HTMLInputElement;
let llmBaseUrlInput: HTMLInputElement;
let llmApiKeyInput: HTMLInputElement;
let llmModelInput: HTMLInputElement;
let characterSettingInput: HTMLTextAreaElement;
let replyFormatInput: HTMLTextAreaElement;
let saveBtn: HTMLButtonElement;
let resetBtn: HTMLButtonElement;
let toast: HTMLElement;

// 显示提示消息
function showToast(message: string) {
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
  }, 2000);
}

// 从表单获取设置值
function getFormValues(): Settings {
  return {
    screenHeightRatio: parseFloat(screenHeightRatioInput.value) || DEFAULT_SETTINGS.screenHeightRatio,
    padding: parseInt(paddingInput.value) || DEFAULT_SETTINGS.padding,
    fpsLimit: parseInt(fpsLimitInput.value) || DEFAULT_SETTINGS.fpsLimit,
    dragWRatio: parseFloat(dragWRatioInput.value) || DEFAULT_SETTINGS.dragWRatio,
    dragHRatio: parseFloat(dragHRatioInput.value) || DEFAULT_SETTINGS.dragHRatio,
    llmBaseUrl: llmBaseUrlInput.value || DEFAULT_SETTINGS.llmBaseUrl,
    llmApiKey: llmApiKeyInput.value || DEFAULT_SETTINGS.llmApiKey,
    llmModel: llmModelInput.value || DEFAULT_SETTINGS.llmModel,
    characterSetting: characterSettingInput.value || DEFAULT_SETTINGS.characterSetting,
    replyFormat: replyFormatInput.value || DEFAULT_SETTINGS.replyFormat
  };
}

// 将设置值填充到表单
function setFormValues(settings: Settings) {
  screenHeightRatioInput.value = settings.screenHeightRatio.toString();
  paddingInput.value = settings.padding.toString();
  fpsLimitInput.value = settings.fpsLimit.toString();
  dragWRatioInput.value = settings.dragWRatio.toString();
  dragHRatioInput.value = settings.dragHRatio.toString();
  llmBaseUrlInput.value = settings.llmBaseUrl;
  llmApiKeyInput.value = settings.llmApiKey;
  llmModelInput.value = settings.llmModel;
  characterSettingInput.value = settings.characterSetting;
  replyFormatInput.value = settings.replyFormat;
}

// 初始化
async function init() {
  // 获取 DOM 元素
  screenHeightRatioInput = document.getElementById("screenHeightRatio") as HTMLInputElement;
  paddingInput = document.getElementById("padding") as HTMLInputElement;
  fpsLimitInput = document.getElementById("fpsLimit") as HTMLInputElement;
  dragWRatioInput = document.getElementById("dragWRatio") as HTMLInputElement;
  dragHRatioInput = document.getElementById("dragHRatio") as HTMLInputElement;
  llmBaseUrlInput = document.getElementById("llmBaseUrl") as HTMLInputElement;
  llmApiKeyInput = document.getElementById("llmApiKey") as HTMLInputElement;
  llmModelInput = document.getElementById("llmModel") as HTMLInputElement;
  characterSettingInput = document.getElementById("characterSetting") as HTMLTextAreaElement;
  replyFormatInput = document.getElementById("replyFormat") as HTMLTextAreaElement;
  saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
  resetBtn = document.getElementById("resetBtn") as HTMLButtonElement;
  toast = document.getElementById("toast") as HTMLElement;

  // 从 Rust 后端加载设置
  console.log("Loading settings from backend...");
  const settings = await loadSettings();
  console.log("Loaded settings:", settings);
  setFormValues(settings);

  // 保存按钮点击事件
  saveBtn.addEventListener("click", async () => {
    const newSettings = getFormValues();
    
    // 保存到 Rust 后端
    console.log("Saving settings to backend:", newSettings);
    await saveSettings(newSettings);
    
    // 发送全局事件通知所有窗口设置已更新
    console.log("Emitting settings-updated event");
    await emit("settings-updated", newSettings);
    
    showToast("✓ 设置已保存");
    
    // 延迟关闭窗口
    setTimeout(async () => {
      const window = getCurrentWindow();
      await window.close();
    }, 1000);
  });

  // 恢复默认按钮点击事件
  resetBtn.addEventListener("click", () => {
    setFormValues(DEFAULT_SETTINGS);
    showToast("已恢复默认设置");
  });
}

// 启动
init().catch(console.error);

