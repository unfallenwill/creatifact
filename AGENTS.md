# openmmcli

openmmcli 是用 create-ts-fast 创建的 TypeScript CLI 项目(tsdown 打包,vitest 测试,tsc 仅做严格类型检查,Biome 做 lint/格式化)。

## 命令

- `npm run dev` - tsx 直接运行 src/index.ts,无需构建
- `npm run typecheck` - tsc 严格类型检查(仅检查,不产出)
- `npm test` - Vitest 单次测试
- `npm run coverage` - Vitest 覆盖率报告(v8)

`npm test` 中的 `src/__tests__/cli.test.ts` 会 spawn `dist/index.mjs` 做集成测试,dist 缺失时自动构建。
- `npm run build` - tsdown 打包到 dist/
- `npm run lint` - Biome 检查 src 与配置文件
- `npm run format` - Biome 格式化并写入
- `npm run smoke` - 运行构建产物 `dist/index.mjs --version` 验证可执行
- `npm run qa` - 完整门禁:typecheck + build + test + lint + smoke(提交/CI 前必跑)
- `npm run clean` - 删除 dist/

## 代码风格

Biome 强制,非 Prettier:2 空格缩进、双引号、无分号。`useLiteralKeys` 已关闭,因为 tsconfig 的 `noPropertyAccessFromIndexSignature` 要求对 `process.env` 用方括号访问,两者冲突。

## 工具约定

- 查询库/框架/CLI 文档时使用 context7。
- 网页搜索、抓取、解析、批量提取内容时使用 firecrawl 相关 skill。
