# openmmcli `pack` 子命令设计

日期:2026-08-13
状态:已批准

## 目标

为 openmmcli 添加 `pack` 子命令:将本地目录打包为符合 OCI image-spec 的
**OCI image layout 目录**,产物兼容 oras / crane,可直接推送 registry。

## 范围

- 本地打包为 OCI layout 目录,不包含推送到 registry(推送交给 oras/crane)。
- 描述文件为可选;简单场景只传 CLI 参数。
- 单层镜像:整个目录压缩为一个 tar.gz 层。

## CLI 接口

`src/index.ts` 增加最小 argv 解析(手写,不引解析库):首个非 flag 参数为子命令。

```
openmmcli pack [options]

Options:
  --dir <path>          要打包的目录(默认 ./plugins)
  --name <repo:tag>     镜像引用,如 org/plugins:1.0.0
  -f, --file <path>     描述文件路径(默认探测 ./openmm-pack.json)
  -o, --output <dir>    输出 OCI layout 目录(默认 ./oci-layout)
  --annotation k=v      写入 manifest annotations,可重复
```

- 无子命令时保持现有交互式 add/subtract 演示;`--version` 行为不变。
- CLI 参数优先覆盖描述文件中的同名字段;annotations 为合并语义,同 key 时 CLI 优先。

## 描述文件(可选)

JSON 格式 `openmm-pack.json`,零依赖解析:

```json
{
  "name": "org/plugins:1.0.0",
  "dir": "./plugins",
  "annotations": { "org.openmm.platform": "CUDA" }
}
```

解析失败(非法 JSON)→ stderr 报错,退出码 1。

## OCI 输出结构

标准 OCI image layout 目录:

```
<output>/
  oci-layout          {"imageLayoutVersion": "1.0.0"}
  index.json          OCI image index,指向 manifest
  blobs/sha256/<d>    digest = sha256,共 3 个 blob:
    - 层:目录内容打包为 tar.gz,mediaType application/vnd.oci.image.layer.v1.tar+gzip
    - config:{},mediaType application/vnd.oci.empty.v1+json
    - manifest:application/vnd.oci.image.manifest.v1+json,含 config、单层、annotations
```

- tar 内为目录内容的相对路径,不带顶层目录前缀。
- digest 用 `node:crypto` 计算;tar 生成用 `tar-stream`。

## 错误处理

pack 为非交互命令,错误统一 stderr 输出 + 退出码 1:

- `--dir` 不存在或为空目录 → 报错
- `--name` 缺失或格式非法(必须含 repo 与 tag 两部分)→ 报错
- 输出目录已存在且非空 → 报错(不覆盖)
- 描述文件存在但解析失败 → 报错

## 数据流

1. 解析 argv → 若有描述文件则读取合并(CLI 优先)
2. 校验:name 必填且含 `:`,dir 存在且非空,output 不存在或为空
3. 用 tar-stream 将 dir 内容流式打包 → gzip → 同时算 sha256 → 写入 `blobs/sha256/<d>`
4. config `{}` 写入 blob;构建 manifest JSON 写入 blob
5. 写 index.json 与 oci-layout
6. 输出成功信息(镜像引用与 layout 路径)

## 模块划分

- `src/pack.ts` — 核心逻辑,纯函数为主,便于单测:
  - `createLayerTarball(dir): Promise<{ digest, size }>`(tar-stream + zlib + crypto,写 blob)
  - `buildManifest(config, layer, annotations): Manifest`
  - `writeIndex(manifests): void`
- `src/index.ts` — 子命令分派与 argv 解析(不新建 cli.ts,项目规模不需要)

## 测试

- 单元测试(`src/__tests__/pack.test.ts`):临时 fixture 目录验证 manifest 结构、digest 正确性
- 集成测试(扩展 `cli.test.ts`):spawn `dist/index.mjs pack ...` → 断言 layout 结构完整,
  用 tar-stream extract 解包验证层内容与 digest 一致;覆盖错误路径(dir 不存在、name 缺失、output 已存在)
- 门禁:`npm run qa` 全绿

## 依赖

- 新增运行时依赖:`tar-stream`
- 新增开发依赖:`@types/tar-stream`
