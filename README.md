# Private Notes

一个部署在 Cloudflare Workers + D1 上的私人文本笔记应用。

- Workers 只处理 `/api/*`
- HTML、CSS、JavaScript 由 Workers Static Assets 边缘分发
- 浏览器使用 PBKDF2-SHA256 + AES-256-GCM 加密标题和正文
- D1 保存密文、时间戳和登录限流状态；API 把单调的 `updated_at` 作为 revision token
- 搜索、解密和筛选都在当前浏览器内完成
- 支持多密码进入相互隔离的 vault
- 支持带有效期的一次性加密分享，收件人主动查看后从当前在线 D1 原子删除记录

## 安全模型

当前实现属于“客户端加密、服务端保存密文”，不是零知识 E2EE：

- 新建 vault 时，同一个密码用于 Worker 访问验证和浏览器派生解密密钥。
- Worker Secret 中仍保存访问密码，因此 Worker/部署管理员属于可信边界。
- 原始 D1 数据泄露时，标题和正文默认是密文；新 API 拒绝写入明文。
- 解密密钥只保存在当前页面内存，不写入 `localStorage`。
- 未配置 `COOKIE_SECRET` 时，Worker 会在自己的 D1 `app_meta` 中原子生成并保存一段独立的 256 位随机签名密钥；它不会用于解密笔记，也不会返回客户端或写入日志。D1 管理员、备份和 Time Travel 因此仍属于可信边界。
- 有效的显式 `COOKIE_SECRET` 始终优先，可用于把签名密钥与 D1 分离。切换或轮换签名密钥会让现有 Session 和尚未领取的分享链接失效。
- 修改 Worker 访问密码会让旧 Session 失效；已有密文仍需要原 vault 密码解锁，直至完成重加密。

一次性分享使用独立的安全边界：

- 浏览器为每个分享生成新的 AES-256-GCM 随机密钥；密钥只放在 URL fragment 中，不会随 HTTP 请求发送给 Worker。
- 分享创建的是独立加密副本，领取或过期不会删除发送者 vault 中的原笔记。
- D1 只保存分享密文、过期时间，以及 token/proof 的二次哈希，不保存原始分享 token、proof 或解密密钥。
- 收件人必须在静态分享页主动点击“查看并销毁”。页面根据 fragment 密钥生成 proof，Worker 使用单条 `DELETE ... RETURNING` 原子取出并删除当前在线记录。
- 分享 token 带有基于当前部署签名密钥的 HMAC，并签入 proof 哈希；普通 GET、聊天软件链接预览、篡改 token、错误 proof 和非 JSON 请求都不会查询或删除对应的 `note_shares` 记录。
- “阅后即焚”只保证从当前在线 D1 删除记录并清除当前页面 DOM，无法阻止收件人复制、截图或使用其他设备拍摄。
- D1 Time Travel、数据库备份或管理员回滚可能恢复已删除记录；恢复后，持有原完整链接的人可能再次领取。因此这不是可验证的物理删除保证。
- 轮换显式 `COOKIE_SECRET`、删除自动签名密钥，或在两种模式间切换，会使尚未领取的分享链接立即失效；对应密文行会在过期清理时删除。
- 完整分享链接本身就是访问能力：聊天、邮件或安全扫描服务可能看到包含 fragment 密钥的原始链接文本。任何取得完整链接的人或服务都可以领取、解密并使在线记录失效，因此只应通过可信渠道发送。
- 领取是 at-most-once：D1 删除成功后若网络响应中断、浏览器关闭或本地解密失败，正常在线流程无法重试。

> 从旧版本升级时，第一次升级后登录必须继续使用旧 `APP_PASSWORD`，让客户端用原加密密码初始化 key-check。初始化成功后可以修改 Worker 访问密码，但必须保留旧 vault 密码；首次使用新访问密码登录时，页面会进入“已认证、待解锁”状态，再输入旧 vault 密码即可解密。删除旧密码前，应先完成全部笔记重加密并保留数据库备份。

从旧版本升级后，如果数据库里仍有历史明文，页面会显示“待加密”。逐条打开并保存即可转换为客户端密文。

## Fork 后部署

项目不再提供 Deploy to Cloudflare 按钮。请先 [Fork 本仓库](https://github.com/tao-t356/private-notes/fork)，让自己的仓库保留 GitHub 上游关系。项目已经固定常规部署配置：Worker 名 `private-notes`、D1 名 `private-notes-db`、生产分支 `main`、构建检查和数据库 migrations，通常不需要修改代码或复制数据库 UUID。

### 1. 导入 Fork

1. 点击上面的 Fork 链接创建自己的仓库。
2. 在 Cloudflare **Workers & Pages → Create application → Import a repository** 中选择自己的 Fork。
3. 保留生产分支 `main`，Build command 留空，只把 Deploy command 设为：

```text
npm run deploy
```

4. 创建或选择一个用于 Workers Builds 的 API Token，至少包含 Account 级 **Workers Scripts: Edit** 和 **D1: Edit**。Cloudflare 自动生成的默认 Builds Token 当前不包含 D1 权限，不能完成自动建库和 migrations。
5. 保存并部署。Wrangler 会自动创建 Worker 和 D1、绑定 `DB`，然后应用仓库中的 migrations；不需要先创建空 Worker、手建 D1 或把 UUID 提交到 Fork。

> D1 automatic provisioning 当前是 Cloudflare Beta。项目锁定了 Wrangler 版本并固定资源名；从 GitHub 部署时 D1 ID 会保存在 Cloudflare，而不会回写到仓库。

> 如果同一 Cloudflare 账号里已经存在同名资源：属于本项目的旧 Worker/D1 时应复用原部署；属于其他项目时，先在 Fork 的 `wrangler.jsonc` 同时修改 Worker `name` 和 D1 `database_name`，避免误连无关资源。普通新账号无需修改。

### 2. 设置唯一必填项

首次部署完成后，进入 Worker 的 **Settings → Variables & Secrets**，添加运行时 Secret `APP_PASSWORD` 并点击 Deploy。建议至少 12 个字符并保存到密码管理器；6 位数字虽然可以登录，但不能抵御数据库泄露后的离线穷举。

在密码设置完成前，Worker 的 API 会主动返回 `503 auth_not_configured`，不会开放无密码访问。不要把密码设置成普通 Variable，也不要放到 Workers Builds 的 Build secret；Build secret 只属于构建环境，不是运行时 Secret。

其他设置全部可选：`APP_PASSWORDS` 可增加隔离 vault；`COOKIE_SECRET` 省略时会在当前 D1 自动生成每个部署独有的 256 位随机密钥；`APP_NAME`、`APP_SHORT_NAME`、`APP_DESCRIPTION` 可用于自定义品牌。`keep_vars` 已开启，后续部署会保留 Dashboard 中的这些变量。

### 3. 后续升级

简单升级可在 GitHub 点击 **Sync fork → Update branch**，Cloudflare 会自动运行固定的 `npm run deploy`，先发布带 schema 门禁的新代码，再应用尚未执行的 D1 migrations；迁移窗口内 API 会 fail closed，迁移完成后自动恢复。

更推荐在 Fork 的 **Actions → Sync upstream Private Notes** 运行安全更新 workflow。首次使用前在 Cloudflare **Settings → Build → Branch control** 关闭 **Builds for non-production branches**，避免尚未验证的更新分支接触生产 D1。Workflow 会保留 Worker/D1 身份和 Dashboard 变量，验证精确 commit 后创建 PR。

> 旧 Deploy Button 创建的是独立仓库，GitHub 不能把它原地转换成 Fork。若旧仓库的 `package.json` 已有 `enable:updates`，可继续运行 `npm run enable:updates -- --push` 启用兼容更新 workflow。更早期、没有该命令的仓库不要直接运行它；最稳妥的迁移方式是 Fork 当前仓库，把旧部署的 Worker `name` 和现有 D1 的 `database_name` / `database_id` 写入新 Fork，再把现有 Worker 的 Builds 连接切换到新 Fork。运行时 Secrets 保留在原 Worker 中，不要新建或删除 D1，确认笔记正常后再归档旧代码仓库。

## 手动部署

要求 Node.js 22 或更高版本。

```bash
npm ci
npx wrangler login
npm run deploy
npx wrangler secret put APP_PASSWORD
```

`npm run deploy` 会自动创建/复用固定 D1，先部署带 schema 门禁的 Worker，再应用远程 migrations。CLI 部署可能把自动创建的 D1 ID 写回 `wrangler.jsonc`，这是当前账号的正常部署身份配置。生产升级应先在 staging D1 验证向后兼容性，并在迁移前记录 D1 Time Travel 恢复点。

## 本地开发

复制本地配置并替换 `APP_PASSWORD` 示例值：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

首次启动前应用本地 migrations：

```bash
npx wrangler d1 migrations apply DB --local
npm run dev
```

`.dev.vars` 中的 `APP_PASSWORD` 只用于本地开发。线上首次部署允许在尚未设置密码时完成资源创建，但所有 API 会 fail closed；必须随后把 `APP_PASSWORD` 添加为 Worker 运行时 Secret。`COOKIE_SECRET` 可在 `.dev.vars` 中显式设置；省略、留空或保留两个已知示例值时，本地/线上 Worker 都会使用当前 D1 自动生成的随机密钥。自定义但少于 32 个字符的覆盖值会 fail closed。如果需要在本地测试额外 vault，可通过 Wrangler 的本地变量覆盖传入 `APP_PASSWORDS`。

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

一次性分享密文上限为 1,000,000 字符，以给 Workers Free 的 10 ms CPU 限制留出余量。超过该体积的笔记仍可正常保存在原 vault，但创建分享时会被拒绝，原笔记不会受影响。

本次 schema 迁移会：

- 删除不再使用、且无法搜索密文的 FTS5 表和触发器
- 删除冗余索引
- 添加适用于 vault + keyset pagination 的复合索引
- 新增只保存客户端密文的一次性分享表和过期时间索引

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
- 每条笔记可创建 1 小时、24 小时或 7 天有效的一次性分享链接
- 分享密钥仅存在于 URL fragment，首次有效领取从当前在线 D1 原子删除
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
- 上游更新器的资源身份保留和无关 Git 历史集成测试
- Workers Runtime 中的 D1 migrations/API 集成测试

上游仓库的 GitHub Actions 会在 push 和 pull request 时运行同一套检查；Dependabot 每月检查 Cloudflare 工具链和 Actions 更新。Cloudflare 一键导入的独立仓库需先按上文启用更新 workflow。

## 项目结构

```text
public/
  index.html
  styles.css
  app.js
  share.html
  share.css
  share.js
  share-crypto.js
  _headers
  manifest.webmanifest
  app-icon.svg
src/
  auth.ts
  index.ts
migrations/
  0001_init.sql
  ...
  0007_one_time_shares.sql
test/
  apply-migrations.ts
  index.spec.ts
.github/workflows/
  ci.yml
  sync-upstream.yml
tools/
  enable-upstream-sync.mjs
  sync-upstream.mjs
  upstream-sync.workflow.yml
wrangler.jsonc
```

## 当前限制

- 主要面向单人或少量独立 vault，不是多人协作系统。
- 不支持图片和附件；未来如增加附件，应在浏览器加密后存入 R2，D1 只保存元数据。
- 当前没有自动密码轮换或恢复密钥流程。
- 当前没有分享列表或提前撤销界面；未领取的分享会在最长 7 天后过期，并在后续创建分享时清理。
- Static Assets 提供应用外壳，但没有离线笔记同步。
- D1 Time Travel 在 Free/Paid 计划分别保留 7/30 天；它也意味着“阅后即焚”记录可能被管理员回滚恢复，长期备份仍应另行保存。

## Cloudflare 参考

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Workers Builds Git integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/)
- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Workers Builds branch control](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)
- [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Wrangler automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)
- [D1 Getting started](https://developers.cloudflare.com/d1/get-started/)
- [D1 Migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [GitHub Syncing a fork](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/syncing-a-fork)
