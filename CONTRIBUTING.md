# 贡献指南

本仓库是一个 MCP 服务器，通过 CDP 或浏览器扩展驱动真实 Chrome。下面是第一次参与前需要知道的事实；凡是没验证过的部分，文中会直接写明"未验证"，不会写成"支持"。

## 平台与运行时

| | 状态 |
|---|---|
| Node | `>= 22`（见 `package.json` 的 `engines`） |
| Windows | **已验证**：Chromium 的 native messaging 宿主与注册表项只在这里有意义，CI 也跑在 `windows-latest` 上 |
| macOS / Linux | **未验证**：测试本身不依赖 Windows（用假传输与假页面），但**没有在这些平台上跑过**；扩展通道也没有在真机上验证过。这不等于"支持" |

之所以把这两行分开写：`npm test` 在没有浏览器的机器上会跳过后端到端那条用例（脚本会在步骤名里说明"跳过了什么"），因此"测试通过"和"这个平台可用"是两个不同的结论。

## 本地起步

```bash
npm install              # 会触发 prepare → npm run build，装完即完成一次编译
npm run verify           # 完整闸门链，提交前必须绿
npm run build:launcher   # 从 launcher/Launcher.cs 编译出 native-host.exe
npm run setup:extension  # 由 host.config.json 生成 extension/host-config.js，再写 manifest 与 HKCU 注册表项
```

各自的作用：

- **`npm install`** —— `package.json` 里有 `"prepare": "npm run build"`，所以装依赖的同时会编译 TypeScript。这是有意为之：`bin` 指向被 `.gitignore` 的 `dist/`，没有 `prepare` 的话干净 clone 里 `npx tabmcp` 直接不可用。
  代价是一句提醒：**如果 `npm install` 在最后的 build 步骤失败，依赖其实已经装好了**，去修类型错误，不要重装。只想恢复依赖时用 `npm install --ignore-scripts`（它不跑 `prepare`）。注意该参数也会跳过依赖自身的 install 脚本——本仓库的依赖没有需要构建的原生模块，但不要把这条姿势带去别的仓库。
- **`npm run verify`** —— 下面那道闸门链，加编译与测试。它是唯一的验收标准。
- **`npm run build:launcher`** —— 产出 `native-host.exe`。该文件在 `.gitignore` 里，**干净 clone 里没有它**，而 `verify` 不检查它，所以"`verify` 绿"不代表浏览器能起得来宿主。编译用 Windows 自带的 .NET Framework `csc`，不需要 .NET SDK（`launcher/` 里没有 `.csproj`，`dotnet build` 从来不适用）。找不到编译器时脚本会非零退出并列出它找过的每一处路径。
- **`npm run setup:extension`** —— 装本机，两步：先由 `host.config.json` **生成** `extension/host-config.js`（会改写仓库里的一个文件），再写 native messaging manifest 与 `HKCU` 注册表项并打印扩展 id。**换目录或换机器后必须重跑**：manifest 里存的是绝对路径，注册表也指向它，两者都不在仓库里。仓库搬家后即使构建全绿，Chrome 仍会去一个已不存在的目录找宿主，而构建输出里没有任何线索。
- **`npm run doctor:host`** —— 只读诊断，回读已安装的 manifest、注册表与可执行文件是否一致。不装浏览器的机器是合法状态，因此它**不在** `verify` 链里。

## 提交前会跑哪些闸

`npm run verify` 依次执行下列步骤，任何一步非零即中止：

| 闸 | 拒绝什么 |
|---|---|
| `lockfile-check` | `package.json` 与 `package-lock.json` 描述的依赖集不一致。本地 `npm install` 会静默修好旧锁文件，所以开发者看不到这种漂移；CI 上的 `npm ci` 会因此直接失败 |
| `generate-host-config --check` | 生成文件 `extension/host-config.js` 与 `host.config.json` 不同步。没有它，手改生成文件再提交就永远不会被发现 |
| `leak-scan` | 任何能指认本机的绝对路径，分三种形状：**盘符**（`<盘符>:\` 后接路径）、**UNC**（两个反斜杠加主机名与共享名）、**`file:///` 开头的非盘符绝对路径**（POSIX 系统下的家目录那种；盘符形式的算第一类，同一处不重复报两个问题）。退出码分明：`0` 干净、`1` 命中、`2` 检查本身没做成；命中项的 `why` 会说明是哪一种 |
| `name-check` | 项目旧名的几种写法 |
| `tool-count` | README 里声明的工具数量与代码里 `registerTool` 的调用数不符（这两者曾经漂过一次） |
| `typecheck` / `build` | 类型错误 |
| `build-completeness` | 运行时会被 `import` 的文件在 `dist/` 里没有产物。`tsc` 退出 0 只说明类型对，不说明编译产物能被加载 |
| `npm test` | 单元测试 |

闸门报错时先看**失败步骤名**再判断归属：这个仓库多人共用一棵工作树，红色经常出现在别人的在办改动或未重新构建的 `dist/` 上，而不是你的代码里。

## 测试约定

- **先红后绿。** 每条修复附一个在修复前会失败的用例，并在报告里写清它是怎么红的。构造不出反例时，直接写"无法构造"和原因，不要静默略过。
- **测不出来的写未验证。** 分支未覆盖、平台未跑过、边界没构造出来，都按"未验证"记，不按"应该没问题"记。
- **跳过必须可见。** 需要浏览器的用例在没有浏览器时跳过，脚本会在步骤名里说明跳过了什么；`REQUIRE_BROWSER=1` 会把该跳过变成失败，供期望有浏览器的环境使用。
- **报数要带分母和出处。** 引用测试结果时写 `# pass N / # tests M @ <commit>`。两个理由：只写 `# tests M` 分不出"跑了"和"跳过了"，而跳过的用例在 dev 机器上是常态；不写 commit 则读者无法判断这份绿是**什么时候**的——同一个仓里 "A 说绿、B 说红" 常常两边都对，只是因为跑的时刻不同、中间又落了新用例。

## 提交约定

- **一次提交一件事。** 重构与行为变更分开；格式化与逻辑改动分开。
- **提交信息写为什么。** 说明这个改动解决了什么问题、为什么这样解，而不是罗列改了哪些文件——文件差异本身已经说了改了什么。
- **不要把会漂的数字写进文档正文。** 测试条数、工具数量、依赖数量都会变；写取法（跑哪条命令、看哪一行）比写结论耐用。已验证的是命令，会过期的是数字。
- **不要为了让闸门变绿而放宽闸门。** 如果某道闸挡住了你，先确认它是错的，再改它——而且改闸要像改代码一样配反例。

## 文档里的其他约定

- 示例路径一律用占位符（如 `<下载目录>`、`<盘符>:\some-dir`），不要出现真实盘符或真实主机名：`leak-scan` 把盘符、UNC 与 `file:///` 绝对路径都当作泄漏，而文档里的真实路径和日志里的真实路径无法区分。
- 命令、字段名、路径保持原文，不翻译。
- 平台支持、安全响应这类承诺，只写已经验证过的部分；没验证的写成未验证。
