# Private Notes

一个部署在 Cloudflare Workers + D1 上的简洁私人笔记。

- 适合单人使用
- 文本优先，支持搜索
- 手机浏览器可直接使用
- 已做基础 PWA 支持，可添加到主屏幕
- 浏览器端端到端加密（E2EE）

## 一键部署到 Cloudflare

当前仓库地址：

- `https://github.com/tao-t356/private-notes`

可以直接使用下面的一键部署按钮：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tao-t356/private-notes)

如果你 fork 了这个仓库，再把按钮里的地址改成你自己的 fork 地址。

## 手动部署

### 1. 安装依赖

```bash
npm install
```

### 2. 登录 Cloudflare

```bash
npx wrangler login
```

### 3. 创建 D1 数据库

```bash
npx wrangler d1 create private-notes-db
```

把返回的 `database_id` 填到 `wrangler.jsonc` 里的 `d1_databases` 配置中。

### 4. 执行数据库迁移

```bash
npx wrangler d1 migrations apply private-notes-db --remote
```

### 5. 设置 secrets

```bash
npx wrangler secret put APP_PASSWORD
npx wrangler secret put COOKIE_SECRET
```

说明：

- `APP_PASSWORD`：登录密码
- `COOKIE_SECRET`：任意长随机字符串，建议 32 字符以上

### 6. 发布

```bash
npx wrangler deploy
```

部署完成后会得到一个 `workers.dev` 地址。

## 本地开发

复制一份本地变量模板：

```bash
cp .dev.vars.example .dev.vars
```

Windows PowerShell 也可以用：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

然后把里面的值改成你自己的。

启动本地开发：

```bash
npx wrangler dev
```

## GitHub 自动部署

除了 Deploy Button，也可以直接在 Cloudflare Dashboard 里：

1. 打开 **Workers & Pages**
2. 连接 GitHub 仓库
3. 选择这个项目
4. 开启 Workers Builds

以后 `git push` 就会自动部署。

## 手机端使用

### iPhone

1. 用 Safari 打开站点
2. 登录
3. 分享 → **添加到主屏幕**

### Android

1. 用 Chrome 打开站点
2. 登录
3. 菜单 → **添加到主屏幕** / **安装应用**

## 主要功能

- 登录保护
- 浏览器端端到端加密
- 笔记新建 / 编辑 / 删除
- 本地标题和正文搜索
- 按日期分组
- 默认折叠长正文，支持展开
- 一键复制全文
- 手机端优化

## 项目结构

```text
src/
  homeHtml.ts   # 前端页面模板
  index.ts      # Worker / API / PWA 路由
migrations/
  0001_init.sql
  0002_notes_fts.sql
wrangler.jsonc
```

## 当前限制

- 不支持图片 / 附件上传
- 更适合单用户而不是多人协作

## 推荐后续增强

- 导出备份
- 搜索历史
- 图片链接预览
- 端到端加密版本
