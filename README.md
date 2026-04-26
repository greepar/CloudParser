## CloudParser

CloudParser 包含两个 JavaScript 处理脚本，用来把云盘分享链接解析成可直接下载的跳转链接。

- `Onedrive.js`：解析 OneDrive 和 SharePoint 分享链接，并跳转到直链下载地址。
- `ICloud.js`：解析 iCloud Drive 分享链接，自动补入原始文件名，并在中国大陆场景下按需替换下载域名。

## 文件说明

- `Onedrive.js`
- `ICloud.js`

每个文件都导出了带有 `fetch(request)` 的默认对象，可以直接用于 Cloudflare Workers 这类运行时环境。

## 使用方式

### OneDrive / SharePoint

支持以下输入形式：

- `/<share_url>`
- `/?url=<share_url>`
- `/onedrive/<share_url>`
- `/oddl/<share_url>`

示例：

```text
https://your-worker.example.com/?url=https://1drv.ms/u/s!example
```

脚本会校验链接域名、按需展开短链接、缓存解析结果，并返回一个 `302` 跳转到最终下载地址。

### iCloud Drive

支持以下输入形式：

- `/<shareId>`
- `/?url=<icloud_share_url>`

示例：

```text
https://your-worker.example.com/?url=https://www.icloud.com/iclouddrive/0123456789ABCDEF#example
```

脚本会通过 Apple 的公开接口解析分享文件信息，把文件名注入最终下载链接，缓存解析结果，并返回一个 `302` 跳转。

## 调试与缓存

- `Onedrive.js` 和 `ICloud.js` 都使用 Cache API（`caches.default`），适合部署在 Worker 风格的运行时中。
- `Onedrive.js` 会返回 `x-debug-cache` 和 `x-debug-final-host` 响应头。
- `ICloud.js` 会返回 `x-debug-cache`、`x-debug-final-host`、`x-debug-country`、`x-debug-domain-patched` 等调试响应头。

## 部署说明

根据你要支持的云盘类型，选择对应的脚本作为 Worker 的入口文件部署即可。
