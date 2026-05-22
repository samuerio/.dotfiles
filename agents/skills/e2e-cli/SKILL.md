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
| `e2e list [--tag X] [--method GET]` | 列出可用接口 |
| `e2e describe <operationId>` | 查看接口详情 |
| `e2e call <operationId> [--path '{}'] [--query '{}'] [--body '{}']` | 调用接口 |
| `e2e run <flow.yml>` | 执行 YAML 流程 |
| `e2e doctor` | 检查配置和连通性 |

所有输出为 `{ "ok": true, "data": ... }` 或 `{ "ok": false, "error": ... }`。

## Flow YAML

支持字段：`call` / `path` / `query` / `body` / `expect.httpStatus` / `expect.json` / `expect.contains` / `save` / `{{var}}` 引用。

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
