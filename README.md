# nodebb-plugin-cp-wukong-topic-chat

这是把你当前 Custom Javascript + 独立 bridge 方案迁移到 NodeBB 插件的骨架包。

本包已经包含：

- NodeBB 官方插件结构：`plugin.json`、`library.js`、`scss`、`staticDirs`。
- `/bridge/...` 路由：兼容你现有前端 JS 里的接口路径。
- 悟空 IM token、topic channel ensure、history sync、presence、notify、activity、Google 翻译、AI proxy、upload proxy。
- 只针对目标板块，默认 `cid = 7`。
- 服务端预隐藏：只有板块 7 的 topic 页会给 `<html>` 注入 `cp-wk-topic-chat-cid7`，用于防止先闪 NodeBB 原帖子样式。
- 不包含完整浏览器聊天室 JS；下一步把你的 `cp-topic-wukong-cid7-vXX.js` 放进插件前端入口。

## 重要提醒

现在这个包 **还没有放入完整前端聊天室 JS**。如果你直接在生产启用，板块 7 的话题页会进入预隐藏 loading，但不会真正渲染聊天室。

开发联调阶段可以临时关闭预隐藏：

```bash
CP_WK_PREHIDE=0 ./nodebb dev
```

等下一步把前端 JS 接进去后，再打开：

```bash
CP_WK_PREHIDE=1 ./nodebb build && ./nodebb restart
```

## 安装

把文件夹放到 NodeBB 根目录的 `node_modules/` 里，或通过 npm/git 安装：

```bash
cd /path/to/nodebb
npm install ./nodebb-plugin-cp-wukong-topic-chat
./nodebb plugin activate nodebb-plugin-cp-wukong-topic-chat
./nodebb build
./nodebb restart
```
## termius安装
```bash
docker update --restart=no nodebb

docker exec -it nodebb sh -lc 'cd /usr/src/app && npm install --legacy-peer-deps --force https://github.com/Hurt6465-ai/nodebb-plugin-cp-wukong-topic-chat/archive/refs/heads/main.tar.gz && ./nodebb build'

docker restart nodebb

docker update --restart=always nodebb
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CP_WK_ENABLED` | `1` | 是否启用插件 |
| `CP_WK_TARGET_CID` | `7` | 只在这个板块的话题页启用聊天室 |
| `CP_WK_PREHIDE` | `1` | 是否启用服务端预隐藏 |
| `CP_WK_HOST` | `http://127.0.0.1:5001` | 悟空管理 API 地址 |
| `CP_WK_MANAGER_TOKEN` | `123456` | 悟空管理 token |
| `CP_WK_SECRET_KEY` | `123456` | 用来签发前端连接 token 的 secret |
| `CP_WK_CHANNEL_TYPE` | `2` | topic room 使用的悟空 channel type |
| `CP_WK_CHANNEL_PREFIX` | `nbb_topic_` | channel id 前缀 |
| `CP_WK_UPLOAD_PROXY_LIMIT_MB` | `80` | `/bridge/upload` 代理接收上限；前端视频 50MB 规则不在这里处理 |
| `CP_WK_AI_PROXY_ENDPOINT` | 空 | 服务端 AI endpoint，可替代前端填写 |
| `CP_WK_AI_PROXY_API_KEY` | 空 | 服务端 AI API key |
| `CP_WK_AI_PROXY_MODEL` | `gpt-4o-mini` | 默认 AI 模型 |

## 前端 JS 下一步接入点

你的完整浏览器 JS 下次放进：

```text
public/lib/topic-chat.js
```

然后把 `plugin.json` 加上：

```json
"scripts": [
  "public/lib/topic-chat.js"
]
```

前端 JS 在 `injectRoot()` 后需要执行：

```js
document.documentElement.classList.add('cp-wk-topic-chat-ready');
```

`unmount()` 或检测到不是目标页时执行：

```js
document.documentElement.classList.remove('cp-wk-topic-chat-ready');
document.documentElement.classList.remove('cp-wk-topic-chat-cid7');
```

## 路由兼容

插件挂载的路由保持与你当前前端一致：

- `GET /bridge/token`
- `GET /bridge/nodebb-user/:uid`
- `POST /bridge/topic-channel/ensure`
- `GET /bridge/topic-history`
- `GET /bridge/get-history`
- `POST /bridge/upload`
- `POST /bridge/topic-activity/touch`
- `GET /bridge/topic-activity`
- `POST /bridge/topic-notify`
- `GET /bridge/topic-notify/list`
- `POST /bridge/topic-notify/done`
- `POST /bridge/topic-presence/ping`
- `GET /bridge/topic-presence`
- `GET /bridge/translate/google`
- `POST /bridge/ai/chat`
- `POST /bridge/conversation/sync`

## 数据文件

activity 和 notify 会写到：

```text
data/cp-wukong-topic-chat/
```

部署多 NodeBB 进程或多机器时，建议后续改成 Redis/数据库存储；这个骨架先保持和你原 bridge JSON 文件行为一致。
