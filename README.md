# Private Notes

一个部署在 Cloudflare Workers + D1 上的私人文本笔记应用。

- Workers 只处理 `/api/*`
- HTML、CSS、JavaScript 由 Workers Static Assets 边缘分发
- 浏览器使用 PBKDF2-SHA256 + AES-256-GCM 加密标题和正文
- D1 保存密文、时间戳和登录限流状态；API 把单调的 `updated_at` 作为 revision token
- 搜索、解密和筛选都在当前浏览器内完成
- 支持多密码进入相互隔离的 vault
- 支持阅后即焚和定时加密分享；定时链接在 24 小时或 7 天有效期内可重复查看

## 安全模型

当前实现属于“客户端加密、服务端保存密文”，不是零知识 E2EE：

- 新建 vault 时，同一个密码用于 Worker 访问验证和浏览器派生解密密钥。
- Worker Secret 中仍保存访问密码，因此 Worker/部署管理员属于可信边界。
- 原始 D1 数据泄露时，标题和正文默认是密文；新 API 拒绝写入明文。
- 默认勾选“记住此设备”：浏览器只在 localStorage 保存一条 JSON 记录（服务端签名会话令牌），不保存密码、AES 解密密钥或笔记。页面使用时才在内存中派生并导入不可导出的 `CryptoKey`；返回设备会先恢复服务端会话，再要求输入笔记密码解锁。取消勾选则不保存会话。
- 记住的设备可恢复服务端会话，但不能直接读取笔记；同源脚本及能访问浏览器存储的人能取得已保存的会话令牌，仍需笔记密码在当前页面内存中派生解密密钥。退出会清除本机记录、编辑框和内存中的明文，并通过独立的 storage 退出通知锁定其他同源标签页，即使没有记住设备也能通知；不依赖 IndexedDB 或 BroadcastChannel。若浏览器完全禁止存储，会提示手动关闭其他标签页。
- 未配置 `COOKIE_SECRET` 时，Worker 会在自己的 D1 `app_meta` 中原子生成并保存一段独立的 256 位随机签名密钥；它不会用于解密笔记，也不会返回客户端或写入日志。D1 管理员、备份和 Time Travel 因此仍属于可信边界。
- 有效的显式 `COOKIE_SECRET` 始终优先，可用于把签名密钥与 D1 分离。切换或轮换签名密钥会让现有 Session 和尚未领取的分享链接失效。
- 修改 Worker 访问密码会让旧 Session 失效；已有密文仍需要原 vault 密码解锁，直至完成重加密。

分享使用独立的安全边界：

- 浏览器为每个分享生成新的 AES-256-GCM 随机密钥；密钥只放在 URL fragment 中，不会随 HTTP 请求发送给 Worker。
- 分享创建的是独立加密副本，领取或过期不会删除发送者 vault 中的原笔记。
- D1 只保存分享密文、分享模式、过期时间，以及 token/proof 的二次哈希，不保存原始分享 token、proof 或解密密钥。
- 收件人必须在静态分享页主动点击“查看分享内容”。阅后即焚链接使用单条 `DELETE ... RETURNING` 原子取出并删除当前在线记录；定时链接只读取记录，在过期前允许重复查看。
- 分享 token 带有基于当前部署签名密钥的 HMAC，并签入 proof 哈希；普通 GET、聊天软件链接预览、篡改 token、错误 proof 和非 JSON 请求都不会查询或删除对应的 `note_shares` 记录。
- “阅后即焚”只保证从当前在线 D1 删除记录并清除当前页面 DOM，无法阻止收件人复制、截图或使用其他设备拍摄；定时链接在期限内可重复读取。
- D1 Time Travel、数据库备份或管理员回滚可能恢复已删除记录；恢复后，持有原完整链接的人可能再次领取。因此这不是可验证的物理删除保证。
- 轮换显式 `COOKIE_SECRET` 或删除自动签名密钥，会使尚未领取的分享链接立即失效；对应密文行会在过期清理时删除。
- 完整分享链接本身就是访问能力：聊天、邮件或安全扫描服务可能看到包含 fragment 密钥的原始链接文本。任何取得完整链接的人或服务都可以领取并解密；阅后即焚领取还会使在线记录失效，定时链接则在期限内可重复读取，因此只应通过可信渠道发送。
- 阅后即焚领取是 at-most-once：D1 删除成功后若网络响应中断、浏览器关闭或本地解密失败，正常在线流程无法重试；定时链接不删除记录，直到过期清理。

> 从旧版本升级时，第一次升级后登录必须继续使用旧 `APP_PASSWORD`，让客户端用原加密密码初始化 key-check。初始化成功后可以修改 Worker 访问密码，但必须保留旧 vault 密码；首次使用新访问密码登录时，页面会进入“已认证、待解锁”状态，再输入旧 vault 密码即可解密。删除旧密码前，应先完成全部笔记重加密并保留数据库备份。

从旧版本升级后，如果数据库里仍有历史明文，页面会显示“待加密”。逐条打开并保存即可转换为客户端密文。

## 登录与记住设备

1. 只保留一个密码框：输入你设置的密码，默认保留“记住此设备”，点击“进入笔记”。不额外要求大小写、特殊字符或密码格式；密码按原样匹配，不自动删除空格。
2. 以后在同一浏览器、同一站点地址打开，会先恢复服务端会话，再要求输入笔记密码解锁；解锁密钥只在当前页面内存中存在，刷新仍需重新输入笔记密码。
3. 公共设备取消勾选；使用后点击退出。退出清除的是本机保存的会话令牌，已复制到其他设备的令牌仍需通过修改访问密码或签名密钥撤销。
4. 清除网站数据、隐私浏览结束、浏览器回收存储、会话超过一年未续期、修改访问密码或签名密钥，仍需要重新登录；浏览器拒绝保存时页面会明确提示。
5. 修改访问密码后，旧密文仍需要原笔记密码；页面在服务端会话验证成功后显示解锁表单。正常登录和刷新不再切换两个表单。

本次升级后需重新输入一次密码，以建立简化后的本机记录；旧 IndexedDB 登录记录会被清理，不改动旧笔记密文和数据库绑定。旧版原生表单认证及 CSRF 令牌分支已删除，旧标签页提交表单或打开 `/api/login` 只会返回首页，不会登录，也不会再显示 Origin 错误。

前端主页面和分享页分别通过 esbuild 打包为面向 Safari 12 语法的普通脚本，避免混用旧缓存；页面和打包脚本均不缓存。记住设备后，刷新先显示笔记页的会话恢复状态；会话恢复成功后显示密码解锁表单，只有确认会话失效或没有本机记录时才回到普通登录表单。临时网络错误保留设备记录并提供重试入口，不缓存笔记明文。正常登录成功后，笔记列表加载失败也可以单独重试。未勾选“记住此设备”时会话和密钥只在当前页面内存中，刷新仍需重新登录。

## 一键部署

仓库地址：`https://github.com/tao-t356/private-notes`

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tao-t356/private-notes)

Cloudflare 会把项目克隆到你的 GitHub/GitLab 账号，并配置 Worker、静态资源和 D1 绑定。当前仓库的 `wrangler.jsonc` 保留了已有部署的数据库 ID，不是无身份信息的通用模板；新账号应核对实际创建的 D1 是否属于自己。需要明确控制首次资源创建时，请使用下方手动部署流程和不含数据库 ID 的 `wrangler.example.jsonc`。已有部署升级时必须保留自己的原配置，不能用新部署模板覆盖。

部署页面只需要修改 `APP_PASSWORD`：

- 使用长且唯一的登录密码，建议至少 12 个字符并保存到密码管理器。
- 6 位数字虽然可以登录，但无法抵御数据库泄露后的离线穷举。
- 确认 Deploy command 是 `npm run deploy`，这样会在部署后应用 D1 migrations；不要改成单独的 `npx wrangler deploy`。

`COOKIE_SECRET` 不需要填写。省略时，Worker 会在自己的 D1 中并发安全地生成每个部署独有的 256 位随机签名密钥。`APP_PASSWORDS`、`APP_NAME`、`APP_SHORT_NAME`、`APP_DESCRIPTION` 都是部署后的可选高级设置，普通用户无需操作。

> Deploy Button 创建的是独立仓库，不是 GitHub Fork。这个项目升级频率较低，正常使用不需要配置同步。以后确实需要升级时，不要再次点击部署按钮，否则会创建新的 Worker/D1；应在原部署仓库中合并更新并继续复用现有数据库。

### 可选：启用上游更新

如需让独立部署仓库以后接收更新，先在 Cloudflare **Settings → Build → Branch control** 关闭非生产分支构建，再在该仓库终端运行：

```bash
npm run enable:updates -- --push
```

随后可在 GitHub **Actions → Sync upstream Private Notes** 创建经过验证的升级 PR。升级工具会保留现有 Worker、D1 ID、routes、Secrets 和自定义变量。

## 手动部署

要求 Node.js 22 或更高版本。

**下面的模板复制步骤只用于首次部署到新账号。已有部署请保留原 `wrangler.jsonc`，直接按升级流程操作，避免创建空的新数据库。**

```bash
npm ci
cp wrangler.example.jsonc wrangler.jsonc
npm run build
npx wrangler login
npx wrangler deploy --secrets-file .dev.vars
npm run db:migrations:apply
```

部署前复制 `.dev.vars.example` 为 `.dev.vars` 并替换 `APP_PASSWORD` 示例值；该文件已被 Git 忽略，不得提交。首次 `wrangler deploy` 会自动创建 D1 并把 ID 写回当前配置，随后 migrations 建立正式 schema。以后升级可直接运行 `npm run deploy`。生产升级应先在 staging D1 验证向后兼容性，并在迁移前记录 D1 Time Travel 恢复点。

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

`wrangler.jsonc` 把 `APP_PASSWORD` 声明为 required secret；缺失时本地开发会警告，生产部署会明确失败。`COOKIE_SECRET` 可在 `.dev.vars` 中显式设置；省略、留空或保留两个已知示例值时，本地/线上 Worker 都会使用当前 D1 自动生成的随机密钥。自定义但少于 32 个字符的覆盖值会 fail closed。如果需要在本地测试额外 vault，可通过 Wrangler 的本地变量覆盖传入 `APP_PASSWORDS`。

## 从旧版本升级

1. 保留当前 `APP_PASSWORD` 和数据库备份，不要先轮换密码。
2. 在 Cloudflare 查看 D1 Time Travel 当前恢复点，并运行 `npx wrangler d1 migrations list DB --remote` 核对旧迁移记录。若旧 Worker 曾运行时修改 schema、但远程 migration journal 不完整，应先在 staging 修复记录冲突，不能直接套用生产迁移。
3. 执行 `npm ci` 和 `npm run check`。
4. 执行 `npm run deploy`；如果使用现有 Workers Builds Git 集成，确认 Deploy command 是 `npm run deploy`，不能只运行 `wrangler deploy` 跳过 D1 migrations。
5. 原有 Session 会失效。继续使用旧 `APP_PASSWORD` 完成第一次登录，让客户端用原加密密码初始化 key-check。
6. 确认旧密文可以解开后，才可修改 Worker 访问密码。之后首次用新密码登录会进入已认证的解锁界面，在那里输入旧 vault 密码。返回设备的服务端会话恢复也会进入同一解锁界面。
7. 检查页面是否提示“无法解密”或“待加密”，并对历史明文笔记逐条打开、保存。
8. 如需彻底停用旧 vault 密码，先实现并完成全部笔记重加密；当前版本不提供自动轮换。

API 当前接受的标题/正文密文上限分别为 32,768/1,400,000 字符。客户端加密会增加体积；极大的历史明文可能无法直接保存，应先导出并拆分。超限请求会被拒绝，原记录不会被覆盖。

一次性分享密文上限为 1,000,000 字符，以给 Workers Free 的 10 ms CPU 限制留出余量。超过该体积的笔记仍可正常保存在原 vault，但创建分享时会被拒绝，原笔记不会受影响。

本次 schema 迁移会：

- 删除不再使用、且无法搜索密文的 FTS5 表和触发器
- 删除冗余索引
- 添加适用于 vault + keyset pagination 的复合索引
- 新增只保存客户端密文的分享表、分享模式和过期时间索引

## 主要能力

- 默认 fail-closed 的密码登录
- 单次 JSON 登录，不再使用 Safari 原生表单跳转兜底；签名 Bearer 令牌使登录不依赖浏览器是否接受 Cookie
- 保留 HttpOnly、Secure、SameSite=Strict、`__Host-` Session Cookie 兼容既有客户端；令牌仅通过请求头传递，不放入 URL
- 会话有效期为一年，每次打开恢复时续期；已认证 API 请求继续续期 Cookie
- 密码变更后自动撤销旧 Session
- 按 IP 的原子登录失败计数
- 多 vault 数据隔离
- 客户端 AES-GCM 加密
- set-once key-check，避免空 vault 使用错误密码初始化
- 基于 `updated_at` 的 revision 乐观锁，避免多标签页静默覆盖或误删
- 稳定游标分页
- 每页最多 10 条，控制接近 D1 单行上限的数据在 Workers 128 MB 内存限制内
- 内存全文搜索：首次加载覆盖全部分页；输入防抖，列表分批展示，但搜索仍覆盖尚未展示的笔记
- 保存和删除成功后增量更新当前列表，不重复下载并解密整个笔记库；正文保留原始首尾空白
- 保存期间禁止重复提交，新建请求使用固定 ID 和相同密文重试，冲突时保留编辑内容
- 每条笔记可创建阅后即焚（一次性）、24 小时有效或 7 天有效的分享链接
- 分享密钥仅存在于 URL fragment；阅后即焚首次有效领取从当前在线 D1 原子删除，定时链接在期限内可重复查看
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
  0008_reusable_shares.sql
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
- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Workers Builds Git integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/)
- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Workers Builds branch control](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)
- [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Wrangler automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)
- [D1 Getting started](https://developers.cloudflare.com/d1/get-started/)
- [D1 Migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
