# Private Notes

一个部署在 Cloudflare Workers + D1 上的私人文本笔记应用。

- Workers 只处理 `/api/*`
- HTML、CSS、JavaScript 由 Workers Static Assets 边缘分发
- 浏览器使用 PBKDF2-SHA256 + AES-256-GCM 加密标题和正文
- D1 保存密文、时间戳和登录限流状态；API 把单调的 `updated_at` 作为 revision token
- 搜索、解密和筛选都在当前浏览器内完成
- 支持多密码进入相互隔离的 vault

## 安全模型

当前实现属于“客户端加密、服务端保存密文”，不是零知识 E2EE：

- 新建 vault 时，同一个密码用于 Worker 访问验证和浏览器派生解密密钥。
- Worker Secret 中仍保存访问密码，因此 Worker/部署管理员属于可信边界。
- 原始 D1 数据泄露时，标题和正文默认是密文；新 API 拒绝写入明文。
- 解密密钥只保存在当前页面内存，不写入 `localStorage`。
- 修改 Worker 访问密码会让旧 Session 失效；已有密文仍需要原 vault 密码解锁，直至完成重加密。

> 从旧版本升级时，第一次升级后登录必须继续使用旧 `APP_PASSWORD`，让客户端用原加密密码初始化 key-check。初始化成功后可以修改 Worker 访问密码，但必须保留旧 vault 密码；首次使用新访问密码登录时，页面会进入“已认证、待解锁”状态，再输入旧 vault 密码即可解密。删除旧密码前，应先完成全部笔记重加密并保留数据库备份。

从旧版本升级后，如果数据库里仍有历史明文，页面会显示“待加密”。逐条打开并保存即可转换为客户端密文。

## 一键部署

仓库地址：`https://github.com/tao-t356/private-notes`

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tao-t356/private-notes)

部署页面会根据 `wrangler.jsonc` 创建并绑定 D1，并要求填写：

- `APP_PASSWORD`：长且唯一的 vault 密码
- `COOKIE_SECRET`：至少 32 个随机字符，用于签名 Session

如需额外 vault，可在部署后按需添加可选 Secret `APP_PASSWORDS`，格式为 `vault_id=password,guest=another-password`。

新部署必须把所有示例值替换为真实的强密码。运行时会拒绝新的 `APP_PASSWORD` 占位值，以及缺失、过短或仍为示例值的 `COOKIE_SECRET`；为兼容已有密文，旧版本遗留的较短 `APP_PASSWORD` 不会被强制拒绝。

## 手动部署

要求 Node.js 22 或更高版本。

```bash
npm install
npx wrangler login
npx wrangler d1 create private-notes-db
```

把返回的 `database_id` 写入 `wrangler.jsonc`，然后在 Cloudflare Dashboard 一次性配置 `APP_PASSWORD` 和 `COOKIE_SECRET`。也可以使用 Wrangler 的批量 Secret 命令，避免逐个 Secret 触发中间版本。

执行检查并部署：

```bash
npm run check
npm run deploy
```

`npm run deploy` 会先应用远程 D1 migrations，再部署 Worker。生产环境应先在 staging D1 验证向后兼容性，并在迁移前记录 D1 Time Travel 恢复点。

## 本地开发

复制本地配置并替换所有示例值：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

首次启动前应用本地 migrations：

```bash
npx wrangler d1 migrations apply DB --local
npm run dev
```

`wrangler.jsonc` 把 `APP_PASSWORD` 与 `COOKIE_SECRET` 声明为 required secrets，供类型生成和本地缺失提示使用；Worker 运行时仍会独立执行 fail-closed 检查。如果需要在本地测试额外 vault，可通过 Wrangler 的本地变量覆盖传入 `APP_PASSWORDS`。

## 从旧版本升级

1. 保留当前 `APP_PASSWORD` 和数据库备份，不要先轮换密码。
2. 在 Cloudflare 查看 D1 Time Travel 当前恢复点，并运行 `npx wrangler d1 migrations list DB --remote` 核对旧迁移记录。若旧 Worker 曾运行时修改 schema、但远程 migration journal 不完整，应先在 staging 修复记录冲突，不能直接套用生产迁移。
3. 执行 `npm ci` 和 `npm run check`。
4. 执行 `npm run deploy`；如果使用现有 Workers Builds Git 集成，确认 Deploy command 是 `npm run deploy`，不能只运行 `wrangler deploy` 跳过 D1 migrations。
5. 原有 Session 会失效。继续使用旧 `APP_PASSWORD` 完成第一次登录，让客户端原子初始化 vault salt/key-check。
6. 确认旧密文可以解开后，才可修改 Worker 访问密码。之后首次用新密码登录会进入解锁界面，在那里输入旧 vault 密码。
7. 检查页面是否提示“无法解密”或“待加密”，并对历史明文笔记逐条打开、保存。
8. 如需彻底停用旧 vault 密码，先实现并完成全部笔记重加密；当前版本不提供自动轮换。

API 当前接受的标题/正文密文上限分别为 32,768/1,400,000 字符。客户端加密会增加体积；极大的历史明文可能无法直接保存，应先导出并拆分。超限请求会被拒绝，原记录不会被覆盖。

本次 schema 迁移会：

- 删除不再使用、且无法搜索密文的 FTS5 表和触发器
- 删除冗余索引
- 添加适用于 vault + keyset pagination 的复合索引

## 主要能力

- 默认 fail-closed 的密码登录
- HttpOnly、Secure、SameSite=Strict、`__Host-` Session Cookie
- 密码变更后自动撤销旧 Session
- 按 IP 的原子登录失败计数
- 多 vault 数据隔离
- 客户端 AES-GCM 加密
- set-once key-check，避免空 vault 使用错误密码初始化
- 基于 `updated_at` 的 revision 乐观锁，避免多标签页静默覆盖或误删
- 稳定游标分页
- 每页最多 10 条，控制接近 D1 单行上限的数据在 Workers 128 MB 内存限制内
- 内存全文搜索
- CSP 和常用浏览器安全响应头
- 安装到手机主屏幕所需的 Web App Manifest

## 质量检查

```bash
npm run check
npm audit
npm run deploy:dry-run
```

`npm run check` 包含：

- Worker TypeScript 类型检查
- 测试代码类型检查
- 浏览器 JavaScript `checkJs`
- Workers Runtime 中的 D1 migrations/API 集成测试

GitHub Actions 会在 push 和 pull request 时运行同一套检查；Dependabot 每月检查 Cloudflare 工具链和 Actions 更新。

## 项目结构

```text
public/
  index.html
  styles.css
  app.js
  _headers
  manifest.webmanifest
  app-icon.svg
src/
  auth.ts
  index.ts
migrations/
  0001_init.sql
  ...
  0006_hardening.sql
test/
  apply-migrations.ts
  index.spec.ts
wrangler.jsonc
```

## 当前限制

- 主要面向单人或少量独立 vault，不是多人协作系统。
- 不支持图片和附件；未来如增加附件，应在浏览器加密后存入 R2，D1 只保存元数据。
- 当前没有自动密码轮换或恢复密钥流程。
- Static Assets 提供应用外壳，但没有离线笔记同步。
- D1 Time Travel 在 Free/Paid 计划分别保留 7/30 天；长期备份仍应另行保存。

## Cloudflare 参考

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [D1 Migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
