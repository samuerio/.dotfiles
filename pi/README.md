# pi 扩展 TypeScript 模块解析问题

本文只记录 coc / tsserver 解析 pi 扩展依赖的问题，不是 `pi/` 目录总览。

## tsserver 模块解析问题

### 问题

neovim + coc 下编辑 `agent/extensions/*.ts` 时，导入 `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 会报红波浪线：

```
Cannot find module '@earendil-works/pi-ai' or its corresponding type declarations.
```

### 原因

TypeScript 语言服务（tsserver）的模块解析只从当前文件所在目录向上层搜索 `node_modules`，**不会扫描全局 npm 目录**（`~/.npm-global/lib/node_modules`）。

这些包虽然通过 `npm install -g @earendil-works/pi-coding-agent` 装在了全局，但 tsserver 找不到它们。

### 解决

在 `pi/` 下创建 `node_modules/@earendil-works/` 符号链接，指向全局安装的实际位置：

```bash
mkdir -p pi/node_modules/@earendil-works

ln -s ~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent \
  pi/node_modules/@earendil-works/pi-coding-agent

# pi-ai 和 pi-tui 是 pi-coding-agent 的嵌套依赖
ln -s ~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai \
  pi/node_modules/@earendil-works/pi-ai

ln -s ~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui \
  pi/node_modules/@earendil-works/pi-tui
```

然后在 neovim 里执行 `:CocRestart` 重启 tsserver，红波浪线消失。

### 关于 tsconfig.json

最初考虑过在 `pi/` 下放 `tsconfig.json` 显式指定 `moduleResolution: "NodeNext"`，但实际测试发现**不需要**。这些包的 `package.json` 同时配置了 `main`/`types` 兜底字段，coc-tsserver 默认就能正确解析。

如果将来遇到新的类型解析问题，可以按需添加 `tsconfig.json` 或 `jsconfig.json`。
