# 上手指南 · Pi Agent Control Room

一句话：**你只对着一块仪表盘说话，仪表盘后面是一个小队在内勤（接线员）和外勤（出勤警）之间分工。**
你提的要求一定有人接话；真正动手的 agent 永远不直接跟你说话。

---

## 1. 30 秒版本

```bash
cd pi-agents-redux-saga-extension
npm ci          # 装依赖（node_modules 不在包里，必须装）

# 终端 A —— 假桥：脚本回放，不调用模型，不花 token
npm run demo

# 终端 B —— 前端
npm run dev
```

打开 **http://127.0.0.1:5173/**，在最下面的输入框里随便说一句，比如

> 重跑一遍 sweep，把 5 个 seeds 都跑了

你会在 6 秒内看到整套行为（下面第 3 节逐条解释）。**这一步不需要 pi、不需要登录、不需要 token。**

---

## 2. 你会看到什么

| 位置 | 内容 |
| --- | --- |
| 顶部四个数字 | **Unanswered**（提了没人应）、**First response**（接话中位耗时）、**Waiting on you**（在等你回话）、**Needs approval**（等你签字的活） |
| 中间 Conversation | 你说的话 + 内勤说的话。只有内勤能出现在这里 |
| 输入框下面一行 | 当前闸门姿态："Nothing the desk proposes reaches the crew until you approve it." 或 "The gate is off" |
| 红色卡片 | 外勤想干活，等你按 **Approve**（`sergeant` 档要按两次 **Confirm**） |
| 折叠的 "What the crew is doing" | 真实活动流：工具调用、思考、stderr 日志、报错 |
| 右侧 Operators | 小队名册：谁是内勤（绿色 **DESK** 标签）、状态、当前任务。**名字可以直接改**（点一下就能编辑），还能 Add / 移除自建的成员 |

### 演示里那条时间线（`npm run demo` 会完整跑一遍）

1. **立刻**：出现一条虚线气泡 `Got it - "重跑 sweep…" is with the desk.` —— 这是**机械回执**，不是模型生成的，所以永远不迟到。
2. 内勤开始说话（文字是**逐段流进来**的，和真实流式一致）。
3. 活动流里出现 crew 的 `Tool call`、`Tool result`，还有一行 stderr `epoch 3: loss 0.412`。
4. 内勤**主动问你一个问题**："3 seeds 跑完，要不要清掉旧 results/ 再跑剩下的 5 个？这会删文件。" → 顶部 **Waiting on you** 变红，右侧内勤卡片变成 **On you**。
5. 一张红色 **sergeant** 工单卡片出现：需要你签字。你不点，活就永远不下发。
6. 点 **Approve** → 活动流出现 `Job taken`，crew 跑完回报 `5 seeds 跑完: mean 81.2 ± 0.6`，然后内勤**把结果翻译成人话**再对你说要不要写进报告。
7. 再来一轮时点 **Decline**（可填理由）→ 内勤收到理由，回复"我没让 crew 执行，改用另一种方式继续"。**被拒的工单不会假装在跑。**

这就是这套东西的全部主张：**排队不是转圈，卡住要喊人，动手要签字。**

---

## 3. 安装

只依赖三样东西：Node ≥ 22.19、这个项目、（可选）pi CLI。

```bash
npm ci                     # 约 20 秒，无 postinstall 脚本
npm test                   # 412 条断言，全在本地跑，不调用模型
npm run preflight          # 体检：Node/pi/信任/端口/桥契约
```

`npm run preflight` 会明确告诉你哪里不对。第一次跑 `npm test` 应该在 20 秒内全绿；它不需要 pi、不需要网络。

---

## 4. 接上真的 agent（会花 token）

### 4.1 先过一次"信任"

`.pi/extensions` 是**受信任门控**的，而 `pi --mode rpc` **不会弹信任提示，直接静默跳过扩展**。没信任时的实测：

```
pi --mode rpc        → 30 个命令，/desk-status 不存在
pi --mode rpc -a     → 32 个命令，/desk-status 存在
```

```bash
cd pi-agents-redux-saga-extension
pi -a          # 进去后答一次 yes，会永久写进 ~/.pi/agent/trust.json
```

验证：

```bash
npm run check:extension -- --approve
# PASS  /dashboard registered
# PASS  /desk-status registered
#       agent-desk: local:desk (desk) tools=dispatch_job,ask_user
```

### 4.2 起服务

```bash
# 终端 A
BRIDGE_TRUST=1 npm run agent-server        # 子进程带 -a，扩展的工具才存在

# 终端 B
npm run dev
```

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `PI_SQUAD` | `duo` | `duo`=内勤+外勤；`trio`=多一个后援（中型项目） |
| `PI_APPROVAL_RANK` | `officer` | **到此档为止自动放行**：`officer`(只读自动) / `detective`(改动自动) / `sergeant`(全自动) |
| `BRIDGE_TRUST` | 关 | 给每个子进程加 `-a`，否则 agent 没有 dispatch/ask 工具 |
| `PI_PROJECT_PATH` | 桥的当前目录 | **小队真正干活的仓库** |
| `BRIDGE_PORT` | `8787` | 桥端口（Vite 代理自动跟随） |

```bash
BRIDGE_TRUST=1 PI_SQUAD=trio PI_PROJECT_PATH=~/work/my-experiment npm run agent-server
```

### 4.3 用

- 输入框发消息 = 提要求/中途加想法/改主意（内勤在忙时会**排队**而不是丢）。
- `Demo run`（右上）= 用固定提示词跑一轮，不改你的对话。
- `pi -a` 里输 `/dashboard` 就能替你打开页面。
- **注意**：按 Send 会真的起一个有完整工具权限的 agent 在 `PI_PROJECT_PATH` 里干活并花 token。想先看效果用第 1 节的 demo。

---

## 5. 在 WiFi 里给别的设备看（手机 / 第二台 Mac）

默认**全部只绑 127.0.0.1**，所以别的设备打不开。三条命令搞定：

```bash
# 终端 A —— 桥开在网络口
PI_LAN=1 BRIDGE_HOST=0.0.0.0 npm run agent-server      # 或 demo 版：npm run demo:lan

# 终端 B —— Vite 开在网络口
npm run dev:lan

# 终端 C —— 拿到本机局域网地址
npm run preflight | grep "LAN address"
#   PASS  LAN address — http://192.168.x.x:5173/ on en0
```

然后另一台设备访问 `http://<本机 IP>:5173/`。（上面两条命令我在这台机器上实测过：页面、`/api/status`、SSE 都能从局域网口走通。）

⚠️ **端口只有一处真值**：Vite 的 `/api` 代理默认指向 `127.0.0.1:8787`。如果你改了桥的端口，**两个终端都要设**同一个 `BRIDGE_PORT`，否则页面能打开、接口全 404：

```bash
BRIDGE_PORT=8790 npm run demo:lan        # 终端 A
BRIDGE_PORT=8790 npm run dev:lan         # 终端 B —— 忘了就会 404
```

要点：

- **防火墙**：macOS 第一次会弹窗问要不要允许 `node` 传入连接，点允许（只影响本机网络，不是互联网）。
- **端口固定**：Vite 现在开了 `strictPort`。5173 被占会**直接报错**，不会再悄悄变成 5174 让 `/dashboard` 打开一个空页面。
- **`/api` 走 Vite 代理**：页面里用的是相对地址，代理在服务端转发到 `127.0.0.1:8787`，所以**不需要**改前端地址，也不碰 CORS。
- **`preflight` 会替你验证**：`LAN reachability — 已监听 / 未监听`，不用自己猜。
- ⚠️ **代价**：同一 WiFi 里任何人都能打开这个页面并**给你的 agent 下指令**。演示完就 `Ctrl-C` 关掉，别长期挂着 `dev:lan`。
- 想在手机上看只是**看**？现在还做不到只读模式——这是个取舍，需要的话可以加一个"只观察不下令"的开关。

---

## 6. 出问题了先查这几条

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| 卡片一直 Working，永远不完 | 桥是旧版（没有故障处理） | 重启桥；`npm run preflight` 会说"this bridge predates the squad work" |
| 右上 `Bridge lost`、页脚 `BRIDGE FAULT` | 桥掉了/子进程退出 | 看折叠的活动流，原因写在那一行里 |
| 输入框发消息得到 Fault + 404 | 桥是旧的（没有 `/api/reply`） | `lsof -ti:8787 \| xargs kill` 后重启 |
| 内勤从不派活，也不提问 | 没信任，扩展工具不存在 | `pi -a` 一次 + 桥加 `BRIDGE_TRUST=1` |
| 红卡片上写 **Confirm** 而不是 Approve | 那是 `sergeant` 档（可摧毁） | 真想干就按两次，否则 Decline |
| 改了名字刷新就没了 | 名字存在浏览器 localStorage（按来源隔离），不跟项目走 | 换设备/换浏览器要重设；不是 bug |
| 手机打不开 | Vite 只绑了 loopback | `npm run dev:lan` + `PI_LAN=1` 开桥 |
| `EADDRINUSE :8787` | 上次没关干净 | `lsof -ti:8787 \| xargs kill` |

---

## 7. 命令速查

```bash
npm run demo              # 看效果：假桥，零 token
npm run dev               # 前端（默认只本机）
npm run dev:lan           # 前端（整个 WiFi 可访问）
npm run demo:lan          # 假桥 + 网络口
npm run agent-server      # 真桥（配 BRIDGE_TRUST=1 / PI_SQUAD / PI_PROJECT_PATH）
npm run agent-server:lan  # 真桥 + 网络口
npm run preflight         # 体检，含 LAN 地址与可达性
npm run check:extension   # pi 里 /dashboard、/desk-status 是否注册 + 工具自报
npm test                  # 412 条断言（无浏览器、无模型）
npm run build             # 生产构建
```

---

## 8. demo 和真桥的差别

| | demo（`scripts/demo-bridge.cjs`） | 真桥（`server.cjs`） |
| --- | --- | --- |
| SSE / 端口 / 帧格式 / 闸门 | **完全一样**（同一套契约，两边都有测试） | 同 |
| 机械回执 | 真实广播 | 真实广播 |
| 谁在说话 | 脚本 | 真 pi 进程 + 真模型 |
| 工具 `dispatch_job` / `ask_user` / `escalate_to_desk` | 不加载（没有 pi） | 需要信任才会加载 |
| 花 token | **不花** | 花 |

demo 里的一切是**脚本**，所以它只能证明"界面和协议长这样"，不能证明模型会做出好决定——后者要在真桥上看，也已经在那里被同样一套契约接住了。

---

## 9. 现在还没做的（别当成已有功能）

- **只读观察模式**（手机上看但不许下令）。
- **档位独立复核**：现在 `rank` 是 agent **自己申报**的，闸门只按申报执行；漏报就等于绕过。
- **项目列表**：现在只有一个项目（`local`/`demo`），多项目并行是下一步。
- **真浏览器点选验证**：测试覆盖了渲染出的 DOM 与协议，但没有 Playwright 点过一遍。
