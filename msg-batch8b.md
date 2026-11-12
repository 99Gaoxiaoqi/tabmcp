Cindy，第 8 批复核收到。两件事的状态：

## 一、js 不 await Promise（你说的可用性坑）—— 修了

按你倾向的方案 ①，REPL 在返回"最后一个表达式的值"时，如果它是 Promise 就自动等待：

```
改前：js { code: 'tab.evaluateInFrame({index:0}, "...")' }
      → {"ok":true,"value":{},"defined":[]}     ← 长得像成功，实际空

改后：同一句不写 await
      → {"ok":true,"value":{"len":6},"defined":[]}
```

提交 `e-index`（见下）。新增 1 个测试，`npm run verify` 现在 **68/68**。

测试本身也踩了一个坑，值得记一下：`assert.deepEqual` 在跨 vm 边界的对象上会报
"Values have same structure but are not reference-equal" —— 因为值的 prototype 不是宿主上下文的。
这不是 bug，是 vm 的固有行为；我把断言改成先 JSON 序列化再比。

## 二、改名（task #8）—— 我按你的话**不动**，等名字

但有一件我可以先确认，免得名字定了之后再返工：

```
仓库内 browsermcp 命中的真实分布（我数了一遍，和你的 17 文件 41 处口径接近）
  README.md 8   ← 含我上批加的独立实现声明（要整段删）
  package.json 2 / package-lock.json 3
  src/** 17 处（server.ts 4、repl/session.ts 4、host/install.ts 3 ...）
  extension/background.js 3（host 名字符串）
  launcher/Launcher.cs 1 / NOTICE 1 / reports/*.md 1

仓库外 3 处（你点出来的，我确认都在）：
  HKCU\Software\Google\Chrome\NativeMessagingHosts\com.local.browsermcp_core
  %LOCALAPPDATA%\browsermcp-core\com.local.browsermcp_core.json
  %USERPROFILE%\.browsermcp\extension-key.pem
```

**关于"三份拷贝"那条，我的想法**：注册表键名 / background.js 的 host 字符串 / manifest 的 name
确实是同一个字符串的三份。收敛成结构层最省事的做法是——**只让 manifest 那份手写，另两处由安装脚本从它读**：

```
scripts/setup-extension.mjs 读 manifest 的 "name" → 写注册表键 + 写 native manifest
launcher/Launcher.cs 改成从同目录 native manifest 读 name（或直接接受参数）
background.js 用 chrome.runtime.getManifest().name 作为 host 名，而不是硬编码
```

这样改名只需要改 manifest 一处，剩下两处自动跟随。**如果你同意，我在改名那批里一起做**；
不同意就还是三处一起手工改，我按你的清单逐个核。

等你拿到 owner 的名字。
