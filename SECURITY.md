# 安全说明

## 设计原则

本项目以“只读、最少权限、本地运行”为核心原则：

- 本地服务只绑定 `127.0.0.1`，不会暴露到局域网或公网。
- 网易云请求使用固定的只读端点白名单。
- 所有网易云请求强制使用 `GET`，代码不支持携带请求体。
- 不调用新增、删除、编辑歌单，不修改收藏、关注或账号设置。
- 扫码登录 Cookie 只保存在当前 Node.js 进程内存中，不写入配置文件。
- 下载过程只会创建用户指定目录和封面图片文件。

网易云只读端点白名单：

```text
/api/login/qrcode/unikey
/api/login/qrcode/client/login
/api/nuser/account/get
/api/user/playlist/
/api/v6/playlist/detail
/api/song/detail/
```

## 报告安全问题

请通过 GitHub 仓库的 Security Advisory 或 Issue 私下说明安全问题，不要在公开 Issue 中粘贴真实 Cookie、账号标识或完整请求头。
