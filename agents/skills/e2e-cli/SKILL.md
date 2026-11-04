---
name: e2e-cli
description: Use e2e-cli to discover and call REST APIs via OpenAPI docs, and execute YAML e2e flow files. Keywords(OpenAPI, Swagger, operationId, e2e flow, API debug).
---

## Setup

```bash
cd /path/to/project
e2e init --base-url http://localhost:8080 --openapi-path /v3/api-docs --bearer-token my-token
e2e sync   # 后端变更后重新同步
```

> `.e2e-cli/` 落在 CWD，必须在目标项目目录下执行。

## Commands

| 命令 | 说明 |
|------|------|
| `e2e list [filter] [--tag X] [--method GET] [--path /api/x]` | 列出可用接口，支持 keyword/tag/method/path 过滤 |
| `e2e describe <operationId>` | 查看接口详情 |
| `e2e call <operationId> [--path '{}'] [--query '{}'] [--body '{}'] [--form 'k=v']` | 调用接口 |
| `e2e run <flow.yml>` | 执行 YAML 流程 |
| `e2e doctor` | 检查配置和连通性 |

所有输出为 `{ "ok": true, "data": ... }` 或 `{ "ok": false, "error": ... }`

## Flow YAML

支持字段：`call` / `path` / `query` / `body` / `form` / `expect.httpStatus` / `expect.json` / `expect.contains` / `save` / `{{var}}` 引用。

```yaml
name: smoke
steps:
  - id: listUsers
    call: HelloController.listUsers
    query:
      page: 0
      size: 10
    expect:
      httpStatus: 200
      json:
        $[0].id: 1
    save:
      firstUserId: $[0].id

  - id: createUser
    call: HelloController.createUser
    body:
      name: Alice
      email: alice@example.com
    expect:
      httpStatus: 201
    save:
      createdUserId: $.id

  - id: getUser
    call: HelloController.getUser
    path:
      id: "{{firstUserId}}"
    expect:
      httpStatus: 200
```

## 大整数 ID（精度安全）

JS 解析 JSON 数字用双精度浮点，超过 ±(2^53 - 1) 的整数（16 位以上 ID，如雪花 ID）传输时会静默丢失精度。CLI 会对此报 `UNSAFE_NUMBER` 错误。

大 ID 一律加引号以字符串形式传，后端 Jackson 默认会把 JSON string 强转成 `Long`：

```bash
e2e call BatchController.deleteUsers --body '["1945594726539875329"]'
```

同样适用于 `--query`、`--path`、`--body-file`，以及 flow YAML 里的数字值（也要加引号：`id: "1945594726539875329"`）。

## 文件上传（multipart/form-data）

对声明了 `multipart/form-data` 的接口用 `--form`（curl `-F` 风格），可重复：

```bash
e2e call UploadController.upload \
  --form 'description=正面照' \
  --form 'file=@./avatar.png'
```

- `field=value` 为文本字段；`field=@path` 为文件字段（路径相对 CWD）
- `;type=mime` 可显式指定 MIME（否则按扩展名推断，未命中用 `application/octet-stream`）：`--form 'doc=@./a.pdf;type=application/pdf'`
- `@@` 开头的值发送字面 `@` 文本：`--form 'handle=@@alice'` 发送 `@alice`
- 同名字段可重复，天然支持多文件
- `--form` 与 `--body` / `--body-file` 互斥（`CONFLICTING_BODY_OPTIONS`）；文件缺失报 `FILE_NOT_FOUND`

Flow YAML 里用 step 级 `form` key，文件路径相对 **flow 文件所在目录**：

```yaml
- id: upload
  call: UploadController.upload
  form:
    description: "avatar upload"
    file: "@./fixtures/avatar.png"
```

`form` 的值支持 `{{var}}` 模板（含文件路径，如 `file: "@{{filePath}}"`）。
