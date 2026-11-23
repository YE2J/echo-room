# DESIGN.md

> 项目：匿名回音（Echo Room）——企业内部匿名意见收集与问题举报聊天室

## 产品气质与意象

- 核心意象：**一间安静、透明的会议室**。没有摄像头，人人戴着同款素色面具，说出来的话被加密封存、身份被拆散保管。克制、可信赖、有温度。
- 设计目标：让人一眼明白「这里说的话被加密保护、身份被拆散保管」，同时不冰冷、不像黑客工具。
- 风格参考：Linear / Notion 式的现代简洁——黑白灰中性色阶 + 单一 Indigo 强调色 + 大量留白 + 无衬线系统字体栈，靠字重/字号/字距/行高做层次，而非装饰。

## 视觉策略

- 单栏纵向对话流，消息如素色卡片依次铺开；顶部为安全状态栏（密文存储、改写开关、连接状态），让"安全机制"被看见、可感知，但用克制的线性图标表达。
- 匿名身份视觉：每个匿名昵称配一枚**几何头像**（由昵称确定性的形状/柔和配色），人人不同但风格统一，强调"有区别的匿名"。
- 不使用真人头像、摄影图、渐变科技蓝；不用拟物锁/盾牌图标堆砌；安全提示用克制的线性图标（Lucide 风格自绘 inline SVG）。

## Design Tokens

### 色彩（浅色，默认）
- `--bg` `#ffffff` 页面背景
- `--bg-subtle` `#fafafa` 次级背景
- `--surface` `#ffffff` 卡片/输入区表面
- `--surface-hover` `#f4f4f5` 悬停底
- `--border` `#e4e4e7` 常规分隔
- `--border-strong` `#d4d4d8` 强调分隔
- `--ink` `#18181b` 正文
- `--ink-secondary` `#52525b` 次要文字
- `--ink-muted` `#a1a1aa` 弱化文字
- `--accent` `#4f46e5` Indigo 强调（焦点/链接）
- `--accent-hover` `#4338ca`
- `--accent-subtle` `#eef2ff` 强调浅底（消息自区/焦点环）
- `--danger` `#dc2626` 危险
- `--success` `#16a34a` 安全/在线
- `--warning` `#d97706` 警示/连接中

### 色彩（暗色，`prefers-color-scheme: dark`）
- `--bg` `#09090b`；`--bg-subtle` `#111113`；`--surface` `#18181b`；`--surface-hover` `#27272a`
- `--border` `#27272a`；`--border-strong` `#3f3f46`
- `--ink` `#fafafa`；`--ink-secondary` `#a1a1aa`；`--ink-muted` `#71717a`
- `--accent` `#818cf8`；`--accent-hover` `#a5b4fc`；`--accent-subtle` `#1e1b4b`
- `--danger` `#f87171`；`--success` `#4ade80`；`--warning` `#fbbf24`

### 圆角 / 字体 / 动效
- 圆角：`--r-sm` 6px、`--r-md` 8px、`--r-lg` 12px、`--r-xl` 16px、`--r-full` 9999px
- 字体：`--font-sans` = `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif`；`--font-mono` = `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace`
- **不使用远程字体**（国内 Google Fonts 不可靠、中文字体文件过大），全站系统字体栈，靠字重/字距/行高做层次
- 动效：`--ease` `cubic-bezier(.4, 0, .2, 1)`，时长 150ms；阴影几乎不用，仅 modal 用 `0 8px 32px rgba(0,0,0,.10)`
- 标题 600 + `letter-spacing: -0.011em`；全站无衬线

## 布局与排版

- 字号节奏：正文 15px/1.65；昵称 13px/600；标题 22px/600；状态/时间 12px mono；时间戳 11px mono `--ink-muted`
- 内容最大宽 760px（消息流 720px 居中）；8px 基准网格，消息间距 20px
- 消息：左 32px 圆形头像 + 第一行（化名 13px/600 + 时间 11px mono）+ 正文 15px/1.65 无气泡边框；自己的消息整条 `--accent-subtle` 底 + 10px 圆角 + 12px 内边距
- Header：sticky top，`color-mix(in srgb, var(--bg) 85%, transparent)` + `backdrop-filter: blur(12px)`，1px 下边框，56px 高
- 输入区：sticky 底部，`--bg` + 1px 上边框；外层容器 1px `--border` + 12px 圆角 + `--surface` 底，`focus-within` 边框变 accent + 3px `--accent-subtle` 环；textarea 无边框无背景、自适应 44–140px；右下 32px 圆形发送按钮（主操作 `--ink` 底 + 白色上箭头 SVG，disabled `--surface-hover` 底 + `--ink-muted` 图标）

## 组件规范

- 认证页：白底居中、无厚重卡片阴影；克制几何 logo（纯 SVG accent 色）；标题 22px/600 + 13px 灰副标题；44px 输入框、label 清晰、focus accent 环（2px + 2px offset）；主按钮 `--ink` 底（暗色白底黑字）全宽 44px 圆角 8px；底部 12px 灰字说明匿名与加密
- 管理面板：modal `--surface` + 1px `--border` + 16px 圆角 + 轻阴影，max-width 640px、padding 24px；页签下划线式；表格无竖线、行高 40px、hover `--surface-hover`、表头 12px `--ink-muted` 不加粗；按钮层级：主操作 `--ink` 底 / 次操作 ghost / 危险 `--danger` 文字 + 透明底
- Toast：右上角 `--surface` + 1px 边框 + 8px 圆角 + 左侧 3px 状态色条、13px 文字、fade + translateY(-4px) 进入
- 自定义滚动条：8px、thumb `--border-strong` 圆角 full、hover `--ink-muted`、track 透明
- 连接状态：1px 细条或状态点表达；connecting 呼吸动画（琥珀），已连接苔绿
- 空状态：居中 40px 描边图标 +「还没有回音」15px/600 + 13px 灰提示（max-width 280px）

## 动效与交互

- 统一 `--ease`，时长 150ms；性格安静、不弹跳
- 消息入场：opacity 0→1 + translateY(4px) 150ms
- 按钮 active `scale(0.98)`；`focus-visible`：2px `--accent` outline + 2px offset（可访问性要求）
- 尊重 `prefers-reduced-motion: reduce`：关闭所有动画

## 响应式（<640px）

- Header 52px；消息 padding 16px 14px；头像 28px；输入区 padding-bottom 加 `env(safe-area-inset-bottom)`；textarea font-size 16px 防 iOS 聚焦缩放

## 设计禁忌

- 禁止科技蓝→蓝紫渐变、深色赛博黑客风、霓虹发光
- 禁止骷髅/盾牌/大锁等恐吓性安全视觉；安全应让人安心而非紧张
- 禁止远程字体/外部图片/CDN 依赖；不装 UI 库
- 禁止拟人 emoji 头像、卡通贴纸、渐变头像（会削弱匿名的庄重感）
- 禁止在消息气泡上暴露真实用户名、邮箱、用户 ID；界面任何角落不出现真实身份
- 禁止给每条消息标注"已被AI改写"之类可形成行为指纹的差异化视觉