# 第三方组件与许可说明

Agetra Terminal v0.2.2 基于用户提供的 Four Agent Terminal v0.2.1 Windows x64 便携包整理。应用更名不改变第三方软件的权利或许可。本文件记录随包信息，不构成额外授权；本项目没有将全部代码统一重新许可为 MIT。

## Binance Agentic Wallet CLI

- 包名：`@binance/agentic-wallet`
- 固定版本：`1.11.0`
- 原始位置：`node_modules/@binance/agentic-wallet/`
- 包元数据中的 `license`：`UNLICENSED`

Windows 便携包保留该第三方组件的原始代码、README、包元数据及内部依赖。Agetra 未修改其代码；本版本材料不包含 Binance 对 Agetra 的重新许可、品牌授权或合作背书证明，也不声称已获得这些授权。公开可下载的 npm 包本身不应被解释为授予任意使用或再分发许可；适用条款与再分发权利需由权利方确认。Agetra 的说明文件不能替代这些条款。

源码包不包含此 CLI 的代码；`package.json` 和 `package-lock.json` 保留固定依赖声明。

## Node.js

Windows 便携包包含 Node.js **v24.14.0 / Windows x64**，来源记录保留在 `runtime/SOURCE.txt`。

- 官方发布目录：<https://nodejs.org/dist/v24.14.0/>
- 原始校验清单：`runtime/SHASUMS256.txt`
- Node.js 及其组成部分的完整许可：`runtime/LICENSE`

打包脚本保留以上文件，不将 Node.js 或其依赖的许可简化为 Agetra 的项目许可。

## ethers 与其他 npm 依赖

直接依赖 `ethers@6.17.0` 的包元数据标为 MIT。它及其他传递依赖的原始 LICENSE、NOTICE、README 和包元数据保留在 Windows 包的 `node_modules/` 中，具体以各组件文件为准。

源码包通过 `package-lock.json` 记录依赖版本与完整性信息；安装得到的第三方组件仍遵循各自原始条款。

## OpenFour ABI 与链配置

原包 `config/manifest.json` 记录 ABI 来源为 [four-meme-community/openfour-docs](https://github.com/four-meme-community/openfour-docs)，参考提交为 `c1729948cc3487d4b4c38a1700664b881a71b561`，并将 ABI 许可标记为 MIT。本版保留 `abi/` 和清单中的来源记录；该记录不是对项目中其他文件的许可声明。

该公开仓库不包含 Binance Agent 专属合约实现源码。包含 ABI 不代表已经独立审核所有合约实现，也不代表获得 Binance 或 Four.meme 背书。
