import * as spine from "@esotericsoftware/spine-webgl";
import { getCurrentWindow, LogicalSize, availableMonitors } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import OpenAI from "openai";
import { loadSettings, setCachedSettings, generateSystemPrompt, MOOD_ANIMATIONS, type Settings } from "./settingsStore";

// 配置（从设置加载，这里是默认值）
const SKELETON_PATH = "assets/arona_spr"; // 不带扩展名
const DEFAULT_ANIMATION = "Idle_01"; // 默认动画名，根据实际情况修改

// 可配置参数（从设置加载）
let FPS_LIMIT = 30;
let FRAME_INTERVAL = 1000 / FPS_LIMIT;
let SCREEN_HEIGHT_RATIO = 0.4;
let PADDING = 20;
let CHAT_BOX_HEIGHT = 100;
let CURSOR_CHECK_INTERVAL = 30;
let DRAG_W_RATIO = 0.4;
let DRAG_H_RATIO = 0.9;

// 窗口最小宽度（防止消息框被挤压）
const MIN_WINDOW_WIDTH = 320;

// LLM 配置（从设置加载）
let LLM_CONFIG = {
  apiKey: "",
  baseURL: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  systemPrompt: ""  // 由 generateSystemPrompt 生成
};

// LLM 重试配置
const LLM_MAX_RETRIES = 3;
const LLM_RETRY_DELAY = 1000; // 重试间隔（毫秒）

// 解析 LLM 回复格式: {心情} | 中文回复 | 日文回复
// 并清理中括号内容（包括中括号本身）
interface ParsedReply {
  mood: string;
  chinese: string;
  japanese: string;
}

function parseReply(rawReply: string): ParsedReply {
  // 清理中括号及其内容的函数（支持中英文中括号）
  const cleanBrackets = (text: string): string => {
    return text
      .replace(/\[[^\]]*\]/g, '')  // 英文中括号 [...]
      .replace(/【[^】]*】/g, '')   // 中文中括号 【...】
      .replace(/\s+/g, ' ')        // 多个空格合并为一个
      .trim();
  };
  
  // 尝试按 | 分割
  const parts = rawReply.split('|').map(p => p.trim());
  
  if (parts.length >= 3) {
    // 标准格式: {心情} | 中文回复 | 日文回复
    return {
      mood: parts[0].replace(/[{}]/g, '').trim(),
      chinese: cleanBrackets(parts[1]),
      japanese: cleanBrackets(parts[2])
    };
  } else if (parts.length === 2) {
    // 两部分: 可能是 {心情} | 回复 或 中文 | 日文
    const first = parts[0];
    if (first.startsWith('{') || first.startsWith('（') || first.startsWith('(')) {
      return {
        mood: first.replace(/[{}（）()]/g, '').trim(),
        chinese: cleanBrackets(parts[1]),
        japanese: ''
      };
    } else {
      return {
        mood: '',
        chinese: cleanBrackets(parts[0]),
        japanese: cleanBrackets(parts[1])
      };
    }
  } else {
    // 单独的回复，没有分隔符
    return {
      mood: '',
      chinese: cleanBrackets(rawReply),
      japanese: ''
    };
  }
}

// 格式化显示回复
function formatReplyForDisplay(parsed: ParsedReply): string {
  let result = parsed.chinese;
  
  // 如果有日文，添加到下一行
  // if (parsed.japanese) {
  //   result += '\n' + parsed.japanese;
  // }
  
  return result;
}

// 当前心情动画
let currentMoodAnimation: string = "00"; // 默认正常表情

// 切换心情叠加动画
function setMoodAnimation(mood: string) {
  if (!animationState) return;
  
  // 查找心情对应的动画编号
  const animationId = MOOD_ANIMATIONS[mood];
  
  if (animationId && animationId !== currentMoodAnimation) {
    console.log(`Switching mood animation: ${mood} -> ${animationId}`);
    currentMoodAnimation = animationId;
    
    // 在轨道 1 上播放心情动画（叠加到基础动画上）
    // mixDuration 设置为 0.2 秒的过渡时间
    const entry = animationState.setAnimation(1, animationId, true);
    if (entry) {
      entry.mixDuration = 0.2;
    }
  } else if (!animationId) {
    console.warn(`Unknown mood: ${mood}, available moods:`, Object.keys(MOOD_ANIMATIONS));
  }
}

// OpenAI 客户端
let openaiClient: OpenAI | null = null;

// 对话历史
let chatHistory: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];

let canvas: HTMLCanvasElement;
let context: spine.ManagedWebGLRenderingContext;
let shader: spine.Shader;
let batcher: spine.PolygonBatcher;
let skeletonRenderer: spine.SkeletonRenderer;
let assetManager: spine.AssetManager;
let mvp: spine.Matrix4;

let skeleton: spine.Skeleton;
let animationState: spine.AnimationState;
let lastFrameTime: number = 0;

// 窗口和骨骼信息
let appWindow: Awaited<ReturnType<typeof getCurrentWindow>>;
let skeletonScreenBounds: { minX: number; minY: number; maxX: number; maxY: number } | null = null;

// 对话框相关
let chatContainer: HTMLElement;
let chatInput: HTMLInputElement;
let sendBtn: HTMLElement;
let historyBtn: HTMLElement;
let messageList: HTMLElement;
let dragHandle: HTMLElement;
let isChatVisible = false;
let isShowingFullHistory = false; // 是否显示完整历史

// 对话框拖动相关
let chatOffsetY = 10; // 对话框距离窗口顶部的距离
let isDraggingChat = false;
let chatDragStartY = 0;
let chatDragStartOffsetY = 0;

// 点击穿透相关
let isIgnoringCursor = false;

// 应用设置
function applySettings(settings: Settings) {
  SCREEN_HEIGHT_RATIO = settings.screenHeightRatio;
  PADDING = settings.padding;
  FPS_LIMIT = settings.fpsLimit;
  FRAME_INTERVAL = 1000 / FPS_LIMIT;
  DRAG_W_RATIO = settings.dragWRatio;
  DRAG_H_RATIO = settings.dragHRatio;
  
  LLM_CONFIG = {
    apiKey: settings.llmApiKey,
    baseURL: settings.llmBaseUrl,
    model: settings.llmModel,
    systemPrompt: generateSystemPrompt(settings)
  };
}

// 初始化 OpenAI 客户端
function initOpenAI() {
  if (!LLM_CONFIG.apiKey) {
    console.warn("OpenAI API Key 未设置，LLM 功能将不可用");
    return;
  }
  
  openaiClient = new OpenAI({
    apiKey: LLM_CONFIG.apiKey,
    baseURL: LLM_CONFIG.baseURL,
    dangerouslyAllowBrowser: true // 在浏览器环境中使用
  });
  
  // 初始化对话历史，添加系统提示
  chatHistory = [
    { role: "system", content: LLM_CONFIG.systemPrompt }
  ];
  
  console.log("OpenAI 客户端初始化成功");
}

// 处理设置更新
async function handleSettingsUpdate(newSettings: Settings) {
  console.log("Handling settings update:", newSettings);
  applySettings(newSettings);
  setCachedSettings(newSettings);
  
  // 重新初始化 OpenAI 客户端
  initOpenAI();
  
  // 重新调整窗口大小
  console.log("Resizing window with new SCREEN_HEIGHT_RATIO:", SCREEN_HEIGHT_RATIO);
  await setupSkeletonAndResize();
  console.log("Window resized with new settings");
}

async function init() {
  // 加载设置（从 Rust 后端）
  console.log("Main window: Loading settings from backend...");
  const settings = await loadSettings();
  console.log("Main window: Loaded settings:", settings);
  applySettings(settings);
  setCachedSettings(settings);
  
  // 监听设置更新事件
  console.log("Main window: Setting up settings-updated listener");
  const unlisten = await listen<Settings>("settings-updated", async (event) => {
    console.log("Main window: Received settings update:", event.payload);
    await handleSettingsUpdate(event.payload);
  });
  console.log("Main window: Listener set up, unlisten function:", unlisten);
  
  // 备用方案：定时检查设置是否有变化
  let lastSettingsJson = JSON.stringify(settings);
  setInterval(async () => {
    try {
      const currentSettings = await loadSettings();
      const currentJson = JSON.stringify(currentSettings);
      if (currentJson !== lastSettingsJson) {
        console.log("Main window: Settings change detected via polling");
        lastSettingsJson = currentJson;
        await handleSettingsUpdate(currentSettings);
      }
    } catch (e) {
      // 忽略错误
    }
  }, 1000); // 每秒检查一次
  
  canvas = document.getElementById("canvas") as HTMLCanvasElement;
  chatContainer = document.getElementById("chat-container") as HTMLElement;
  chatInput = document.getElementById("chat-input") as HTMLInputElement;
  sendBtn = document.getElementById("send-btn") as HTMLElement;
  historyBtn = document.getElementById("history-btn") as HTMLElement;
  messageList = document.getElementById("message-list") as HTMLElement;
  dragHandle = document.getElementById("drag-handle") as HTMLElement;

  // 创建 ManagedWebGLRenderingContext，启用透明
  const config: WebGLContextAttributes = { 
    alpha: true,
    premultipliedAlpha: true,
    antialias: true
  };
  context = new spine.ManagedWebGLRenderingContext(canvas, config);
  
  if (!context.gl) {
    console.error("WebGL not supported");
    return;
  }

  // 初始化 Spine 渲染器
  shader = spine.Shader.newTwoColoredTextured(context);
  batcher = new spine.PolygonBatcher(context);
  skeletonRenderer = new spine.SkeletonRenderer(context);
  mvp = new spine.Matrix4();

  // 加载资源
  assetManager = new spine.AssetManager(context, "/");
  
  // 加载 .skel (二进制格式) 和 atlas
  assetManager.loadBinary(`${SKELETON_PATH}.skel`);
  assetManager.loadTextureAtlas(`${SKELETON_PATH}.atlas`);

  // 等待资源加载完成
  await waitForAssets();
  
  // 设置骨骼并自适应窗口
  await setupSkeletonAndResize();
  
  // 设置窗口拖拽
  setupWindowDrag();
  
  // 设置对话框事件
  setupChat();
  
  // 初始化 OpenAI 客户端
  initOpenAI();
  
  // 启动鼠标位置轮询检测
  startCursorTracking();
  
  // 监听窗口大小变化
  window.addEventListener("resize", onWindowResize);
  
  // 开始渲染循环
  lastFrameTime = performance.now();
  requestAnimationFrame(render);
}

// 启动鼠标位置轮询
function startCursorTracking() {
  setInterval(async () => {
    await checkCursorPosition();
  }, CURSOR_CHECK_INTERVAL);
}

// 检测鼠标位置并更新穿透状态
async function checkCursorPosition() {
  if (!appWindow || !skeletonScreenBounds) return;
  
  try {
    // 获取窗口位置
    const pos = await appWindow.outerPosition();
    const scaleFactor = await appWindow.scaleFactor();
    
    // 获取全局鼠标位置（物理像素）
    const [cursorX, cursorY] = await invoke<[number, number]>("get_cursor_position");
    
    // 转换为窗口内逻辑坐标
    // Windows API 返回的是物理像素，需要除以缩放因子
    const localX = (cursorX - pos.x) / scaleFactor;
    const localY = (cursorY - pos.y) / scaleFactor;
    
    // 检测是否在骨骼区域或对话框区域
    const inSkeleton = isPointInSkeletonBounds(localX, localY);
    const inChat = isPointInChatArea(localX, localY);
    const shouldIgnore = !inSkeleton && !inChat;
    
    // 只在状态变化时更新
    if (shouldIgnore !== isIgnoringCursor) {
      isIgnoringCursor = shouldIgnore;
      await invoke("set_ignore_cursor_events", { ignore: shouldIgnore });
    }
  } catch (err) {
    // 忽略错误
  }
}

// 检测鼠标是否在拖拽区域内（骨骼中心的矩形区域）
function isPointInSkeletonBounds(localX: number, localY: number): boolean {
  if (!skeletonScreenBounds) return false;
  
  const bounds = skeletonScreenBounds;
  
  // 计算骨骼的中心点和尺寸
  const skeletonWidth = bounds.maxX - bounds.minX;
  const skeletonHeight = bounds.maxY - bounds.minY;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  
  // 计算拖拽区域（以骨骼中心为中心）
  const dragWidth = skeletonWidth * DRAG_W_RATIO;
  const dragHeight = skeletonHeight * DRAG_H_RATIO;
  const dragMinX = centerX - dragWidth / 2;
  const dragMaxX = centerX + dragWidth / 2;
  const dragMinY = centerY - dragHeight / 2;
  const dragMaxY = centerY + dragHeight / 2;
  
  return (
    localX >= dragMinX &&
    localX <= dragMaxX &&
    localY >= dragMinY &&
    localY <= dragMaxY
  );
}

// 检测鼠标是否在对话框区域
function isPointInChatArea(localX: number, localY: number): boolean {
  if (!isChatVisible) return false;
  
  const rect = chatContainer.getBoundingClientRect();
  return (
    localX >= rect.left &&
    localX <= rect.right &&
    localY >= rect.top &&
    localY <= rect.bottom
  );
}

// 更新骨骼在屏幕上的边界
function updateSkeletonScreenBounds() {
  if (!skeleton) return;
  
  // 确保世界变换是最新的
  skeleton.updateWorldTransform(spine.Physics.update);
  
  const offset = new spine.Vector2();
  const size = new spine.Vector2();
  skeleton.getBounds(offset, size);
  
  // getBounds 返回的 offset 已经是世界坐标（包含了 skeleton.x/y 的影响）
  // offset 是边界框左下角的坐标（Spine 坐标系，Y 向上）
  // 需要转换到屏幕坐标系（Y 轴向下，原点在左上角）
  
  const worldMinX = offset.x;
  const worldMaxX = offset.x + size.x;
  const worldMinY = offset.y;
  const worldMaxY = offset.y + size.y;
  
  // 转换到屏幕坐标
  const screenMinX = worldMinX;
  const screenMaxX = worldMaxX;
  const screenMinY = canvas.height - worldMaxY; // Spine 的 maxY 对应屏幕的 minY
  const screenMaxY = canvas.height - worldMinY; // Spine 的 minY 对应屏幕的 maxY
  
  skeletonScreenBounds = { 
    minX: screenMinX, 
    minY: screenMinY, 
    maxX: screenMaxX, 
    maxY: screenMaxY 
  };
}

// 设置窗口拖拽功能
function setupWindowDrag() {
  // 整个 canvas 都可以拖拽窗口
  canvas.addEventListener("mousedown", async (e) => {
    if (e.button === 0) {
      await appWindow.startDragging();
    }
  });
  
  // 右键切换对话框显示
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    toggleChat();
  });
}

// 设置对话框
function setupChat() {
  // 发送按钮点击
  sendBtn.addEventListener("click", () => {
    sendMessage();
  });

  // 回车发送
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // 阻止输入框的鼠标事件冒泡（防止拖拽窗口）
  chatContainer.addEventListener("mousedown", (e) => {
    e.stopPropagation();
  });
  
  // 历史按钮点击 - 切换显示完整历史/只显示最后一轮
  historyBtn.addEventListener("click", () => {
    isShowingFullHistory = !isShowingFullHistory;
    historyBtn.textContent = isShowingFullHistory ? "收起" : "历史";
    renderMessageList();
  });
  
  // 对话框拖动
  setupChatDrag();
}

// 设置对话框拖动
function setupChatDrag() {
  dragHandle.addEventListener("mousedown", (e) => {
    isDraggingChat = true;
    chatDragStartY = e.clientY;
    chatDragStartOffsetY = chatOffsetY;
    e.preventDefault();
  });
  
  window.addEventListener("mousemove", (e) => {
    if (isDraggingChat) {
      const deltaY = e.clientY - chatDragStartY;
      chatOffsetY = Math.max(10, chatDragStartOffsetY + deltaY); // 最小距离顶部 10px
      updateChatPosition();
    }
  });
  
  window.addEventListener("mouseup", () => {
    if (isDraggingChat) {
      isDraggingChat = false;
    }
  });
}

// 更新对话框位置
function updateChatPosition() {
  chatContainer.style.top = `${chatOffsetY}px`;
}

// 切换对话框显示
function toggleChat() {
  isChatVisible = !isChatVisible;
  if (isChatVisible) {
    chatContainer.classList.add("visible");
    chatInput.focus();
    // 默认只显示最后一轮
    isShowingFullHistory = false;
    historyBtn.textContent = "历史";
    renderMessageList();
  } else {
    chatContainer.classList.remove("visible");
  }
}

// 渲染消息列表
function renderMessageList() {
  messageList.innerHTML = "";
  
  // 过滤掉系统消息，只显示用户和助手的对话
  const messages = isShowingFullHistory 
    ? chatHistory.filter(m => m.role !== "system")
    : chatHistory.filter(m => m.role !== "system").slice(-2); // 只显示最后一轮（最后2条消息）
  
  if (messages.length === 0) {
    messageList.classList.remove("visible");
    return;
  }
  
  messages.forEach((msg) => {
    const item = document.createElement("div");
    item.className = `msg-item ${msg.role}`;
    
    if (msg.role === "user") {
      item.textContent = `你: ${msg.content}`;
    } else if (msg.role === "assistant") {
      item.textContent = msg.content;
    }
    
    messageList.appendChild(item);
  });
  
  messageList.classList.add("visible");
  
  // 滚动到底部
  messageList.scrollTop = messageList.scrollHeight;
}

// 发送消息
async function sendMessage() {
  const message = chatInput.value.trim();
  if (!message) return;

  // 清空输入框
  chatInput.value = "";
  
  // 禁用发送按钮
  sendBtn.setAttribute("disabled", "true");
  sendBtn.textContent = "...";

  // 添加用户消息到历史并显示
  chatHistory.push({ role: "user", content: message });
  renderMessageList();

  // 如果没有配置 API Key，显示提示
  if (!openaiClient) {
    chatHistory.push({ role: "assistant", content: "⚠️ 请先在代码中配置 LLM_CONFIG.apiKey" });
    renderMessageList();
    sendBtn.removeAttribute("disabled");
    sendBtn.textContent = "发送";
    return;
  }

  // 添加临时的"思考中"消息
  chatHistory.push({ role: "assistant", content: "思考中..." });
  renderMessageList();

  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= LLM_MAX_RETRIES; attempt++) {
    try {
      // 调用 OpenAI API（不包含临时消息）
      const messagesForAPI = chatHistory.slice(0, -1); // 去掉最后的"思考中"
      const completion = await openaiClient.chat.completions.create({
        model: LLM_CONFIG.model,
        messages: messagesForAPI,
      });
      
      const reply = completion.choices[0]?.message?.content;
      
      // 检查是否有有效回复
      if (!reply || reply.trim() === "") {
        throw new Error("LLM 返回空回复");
      }
      
      // 解析回复格式
      const parsed = parseReply(reply);
      const displayReply = formatReplyForDisplay(parsed);
      
      console.log("Raw reply:", reply);
      console.log("Parsed reply:", parsed);
      console.log("Display reply:", displayReply);
      
      // 根据心情切换叠加动画
      if (parsed.mood) {
        setMoodAnimation(parsed.mood);
      }
      
      // 替换"思考中"为实际回复
      chatHistory[chatHistory.length - 1] = { role: "assistant", content: displayReply };
      
      // 保持历史记录不要太长（保留系统提示 + 最近10轮对话）
      if (chatHistory.length > 21) {
        chatHistory = [
          chatHistory[0], // 系统提示
          ...chatHistory.slice(-20) // 最近20条消息
        ];
      }
      
      // 更新显示
      renderMessageList();
      
      // 恢复发送按钮
      sendBtn.removeAttribute("disabled");
      sendBtn.textContent = "发送";
      
      // 成功，退出重试循环
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(`LLM 请求失败 (尝试 ${attempt}/${LLM_MAX_RETRIES}):`, lastError.message);
      
      // 如果还有重试机会，等待后重试
      if (attempt < LLM_MAX_RETRIES) {
        chatHistory[chatHistory.length - 1] = { role: "assistant", content: `思考中... (重试 ${attempt}/${LLM_MAX_RETRIES - 1})` };
        renderMessageList();
        await new Promise(resolve => setTimeout(resolve, LLM_RETRY_DELAY));
      }
    }
  }
  
  // 所有重试都失败
  console.error("LLM 请求最终失败:", lastError);
  const errorMessage = lastError?.message || "未知错误";
  chatHistory[chatHistory.length - 1] = { role: "assistant", content: `❌ 请求失败: ${errorMessage}` };
  renderMessageList();
  
  // 恢复发送按钮
  sendBtn.removeAttribute("disabled");
  sendBtn.textContent = "发送";
}

function waitForAssets(): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (assetManager.isLoadingComplete()) {
        if (assetManager.hasErrors()) {
          console.error("Asset loading errors:", assetManager.getErrors());
          reject(assetManager.getErrors());
        } else {
          resolve();
        }
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  });
}

async function setupSkeletonAndResize() {
  appWindow = getCurrentWindow();
  
  // 获取屏幕尺寸
  const monitors = await availableMonitors();
  const primaryMonitor = monitors[0];
  const screenHeight = primaryMonitor?.size.height || 1080;
  
  // 计算目标骨骼高度
  const targetSkeletonHeight = Math.round(screenHeight * SCREEN_HEIGHT_RATIO);
  
  // 获取加载的资源
  const atlas = assetManager.require(`${SKELETON_PATH}.atlas`) as spine.TextureAtlas;
  const atlasLoader = new spine.AtlasAttachmentLoader(atlas);
  
  // 先用 scale=1 加载骨骼，获取原始尺寸
  const skeletonBinary = new spine.SkeletonBinary(atlasLoader);
  skeletonBinary.scale = 1;
  
  const skeletonData = skeletonBinary.readSkeletonData(
    assetManager.require(`${SKELETON_PATH}.skel`) as Uint8Array
  );

  // 创建临时骨骼来计算边界
  const tempSkeleton = new spine.Skeleton(skeletonData);
  tempSkeleton.setToSetupPose();
  tempSkeleton.updateWorldTransform(spine.Physics.update);
  
  // 计算骨骼边界
  const bounds = calculateSkeletonBounds(tempSkeleton);
  const skeletonWidth = bounds.width;
  const skeletonHeight = bounds.height;
  
  console.log(`Skeleton original size: ${skeletonWidth} x ${skeletonHeight}`);
  
  // 计算缩放比例
  const scale = targetSkeletonHeight / skeletonHeight;
  
  // 计算骨骼缩放后的宽度
  const scaledSkeletonWidth = Math.round(skeletonWidth * scale);
  
  // 计算实际窗口尺寸（加上对话框高度），确保不小于最小宽度
  const windowWidth = Math.max(MIN_WINDOW_WIDTH, scaledSkeletonWidth + PADDING * 2);
  const windowHeight = Math.round(targetSkeletonHeight + PADDING * 2 + CHAT_BOX_HEIGHT);
  
  console.log(`Window size: ${windowWidth} x ${windowHeight}, scale: ${scale}, scaledSkeletonWidth: ${scaledSkeletonWidth}`);
  
  // 调整窗口大小
  await appWindow.setSize(new LogicalSize(windowWidth, windowHeight));
  
  // 等待窗口调整完成
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // 更新 canvas 尺寸
  canvas.width = windowWidth;
  canvas.height = windowHeight;
  
  // 重新加载骨骼，应用计算好的缩放
  const skeletonBinary2 = new spine.SkeletonBinary(atlasLoader);
  skeletonBinary2.scale = scale;
  
  const scaledSkeletonData = skeletonBinary2.readSkeletonData(
    assetManager.require(`${SKELETON_PATH}.skel`) as Uint8Array
  );

  // 创建骨骼实例
  skeleton = new spine.Skeleton(scaledSkeletonData);
  skeleton.setToSetupPose();
  
  // 重新计算缩放后的边界
  skeleton.updateWorldTransform(spine.Physics.update);
  const scaledBounds = calculateSkeletonBounds(skeleton);
  
  // 设置位置（居中，角色在底部）
  skeleton.x = windowWidth / 2 - scaledBounds.centerX;
  skeleton.y = PADDING - scaledBounds.minY;

  // 创建动画状态
  const animationStateData = new spine.AnimationStateData(scaledSkeletonData);
  animationStateData.defaultMix = 0.2;
  animationState = new spine.AnimationState(animationStateData);
  
  // 打印可用的动画列表
  console.log("Available animations:");
  scaledSkeletonData.animations.forEach((anim) => {
    console.log(`  - ${anim.name}`);
  });
  
  // 播放默认动画
  const animations = scaledSkeletonData.animations;
  if (animations.length > 0) {
    const targetAnim = animations.find(a => a.name === DEFAULT_ANIMATION) || animations[0];
    animationState.setAnimation(0, targetAnim.name, true);
    console.log(`Playing animation: ${targetAnim.name}`);
    
    // 设置默认心情动画（正常表情）叠加到轨道 1
    animationState.setAnimation(1, "00", true);
    console.log("Playing default mood animation: 00 (正常)");
  }
  
  // 初始化骨骼屏幕边界
  updateSkeletonScreenBounds();
}

// 计算骨骼边界
function calculateSkeletonBounds(skeleton: spine.Skeleton): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
} {
  skeleton.updateWorldTransform(spine.Physics.update);
  
  const offset = new spine.Vector2();
  const size = new spine.Vector2();
  skeleton.getBounds(offset, size);
  
  const minX = offset.x;
  const minY = offset.y;
  const maxX = offset.x + size.x;
  const maxY = offset.y + size.y;
  
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: size.x,
    height: size.y,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2
  };
}

function onWindowResize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  
  if (skeleton) {
    // 重新计算骨骼位置（角色在底部）
    const bounds = calculateSkeletonBounds(skeleton);
    skeleton.x = canvas.width / 2 - bounds.centerX;
    skeleton.y = PADDING - bounds.minY;
    
    // 更新骨骼屏幕边界
    updateSkeletonScreenBounds();
  }
}

function render(now: number) {
  requestAnimationFrame(render);
  
  const delta = now - lastFrameTime;
  
  // 限制帧率
  if (delta < FRAME_INTERVAL) {
    return;
  }
  
  lastFrameTime = now - (delta % FRAME_INTERVAL);
  const deltaSeconds = Math.min(delta / 1000, 0.1);

  const gl = context.gl;

  // 清除画布（透明背景）
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // 启用混合（透明度）
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  // 更新动画
  animationState.update(deltaSeconds);
  animationState.apply(skeleton);
  skeleton.updateWorldTransform(spine.Physics.update);

  // 设置正交投影矩阵
  mvp.ortho2d(0, 0, canvas.width, canvas.height);

  // 渲染骨骼
  shader.bind();
  shader.setUniformi(spine.Shader.SAMPLER, 0);
  shader.setUniform4x4f(spine.Shader.MVP_MATRIX, mvp.values);

  batcher.begin(shader);
  skeletonRenderer.draw(batcher, skeleton);
  batcher.end();

  shader.unbind();
}

// 启动
init().catch(console.error);
