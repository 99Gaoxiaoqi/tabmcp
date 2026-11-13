# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循语义化版本。

本文件只记录**面向使用者与贡献者的变化**，不逐条列举提交。凡是"未验证"的条目都会明说，不会写成"支持"。

## [0.1.0] - 首个公开版本

### 新增

- **两条传输通道**：CDP（连一个已经开着的 Chrome）与浏览器扩展（native messaging 宿主 + `chrome.debugger`）。两条通道对外暴露同一套工具与同一套错误码。
- **浏览器工具集**：`browser_goto` / `browser_navigate` / `browser_act` / `browser_observe` / `browser_read` / `browser_screenshot` / `browser_cookies` / `browser_network_read` / `browser_tabs` / `browser_tabs_select` / `browser_download` / `doctor`。
- **站点适配器**：`sites_search` 检索已安装适配器，`site_run` 执行；每个适配器同时注册为一条独立工具（如 `<站点>_<命令>`），参数按适配器声明的类型校验。
- **JavaScript REPL**：`js` / `js_reset`，在页面里保留绑定的同时逐条求值。
- **抓包与草稿**：`recon_start` / `recon_report` / `recon_draft`，从真实请求里推出适配器草稿。
- **文档即接口**：文档同时以工具（`docs_get`）与 MCP resources 暴露，避免"文档说一套、实现做一套"只能靠人读出来。

### 修复（按主题）

- **"没有"与"没测"必须能分辨**：探测失败不再被当作实测的零值；截断的输出不再与"没有内容"同形；工具答复统一带上能分支的 `code`。
- **不受欢迎的重复**：可能已经发生的动作（点击、求值、选中标签、新建页面）在会话被替换后不再自动重跑，而是明确告知"动作可能已经发生"。
- **前台提示只在能判定时出现**：多窗口并排时无法判断用户在看哪一个，此时选择沉默，而不是猜一个。
- **宿主名不再被发明**：找不到配置时不再静默回落到默认值；两侧读者用同一套校验规则，并由一条对拍测试钉住。
- **测试不再依赖启动目录**：以 `process.cwd()` 定位自身的测试改为锚定测试文件自己，避免"从哪里启动"改变结论。
- **锁文件不再指向内部源**，外部 clone 可以正常安装。

### 工程与闸门

`npm run verify` 串联下列检查，任何一步非零即中止：

- `lockfile-check` —— `package.json` 与锁文件的依赖集一致（本地安装会静默修好锁文件，所以必须由闸门发现）。
- `generate-host-config --check` —— 生成文件与源配置不同步即失败。
- `leak-scan` —— 禁止任何指认本机的绝对路径；三个退出码区分"干净 / 命中 / 检查没做成"。
- `name-check` —— 项目旧名不得出现。
- `tool-count` —— README 声明的工具数与 `registerTool` 调用数一致。
- `build-completeness` —— 运行时会被 import 的文件必须在 `dist/` 里有产物（`tsc` 退出 0 不保证这一点）。
- 类型检查、编译、单元测试。

配套工具：`npm run build:launcher`（编译 native messaging 宿主，失败时大声退出并列出找过的路径）、`npm run doctor:host`（只读回读已安装的 manifest 与注册表，不进入 `verify`）。

### 已知限制

- **Windows 已验证；macOS / Linux 未验证。** 测试可以在这些平台跑，但扩展通道没有在真机上验证过。这是"未验证"，不是"支持"。
- **"前台"是推断值。** CDP 通道用 `document.visibilityState`，扩展通道用 `chrome.tabs.active`；两者都只是代理量，且多窗口时可能同时为真。真正的前台判定需要订阅 CDP 的 target 事件，目前未做。
- **浏览器相关用例在无浏览器时跳过**，跳过原因写在测试步骤名里；`REQUIRE_BROWSER=1` 会把它变成失败。
- **launcher 构建只在开发机上验证过**（Windows 自带 `csc`），未在多台机器或干净 clone 之外的场景复验。
- **安全策略**见 `SECURITY.md`；本项目为单人维护，不承诺响应时限。
