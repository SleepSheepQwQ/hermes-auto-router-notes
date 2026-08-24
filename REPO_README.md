# Hermes WebUI / auto-router 均衡路由项目 — 工作记录

> 最后更新: 2026-08-24
> 环境: Android 14 · Termux (非 proot) · aarch64
> 仓库用途: 记录 `hy3` 模型代理 + `auto` 均衡路由器的实现、已知问题与进度。

---

## 1. 运行环境

| 项 | 值 |
|---|---|
| OS | Android 14 (Termux, **非 proot**) |
| CPU | aarch64 |
| Node | v26.4.0 |
| Python | 3.13.13 |
| 进程管理 | 无 systemd/Docker; 后台靠 `nohup ... &` |
| GitHub | 已登录 `SleepSheepQwQ` (token scope 含 `repo`/`write:packages`) |
| Workspace | `/data/data/com.termux/files/home/workspace` |

### 关键约束
- **无 Docker / systemd**, 排除 LiteLLM、Portkey、Bifrost 等重型方案。
- `~/.hermes/config.yaml` 有写保护, 必须走 `hermes config set` 官方通道。
- 商汤 `token-plan` 渠道需从 `~/.hermes/.env` 读 key (shell 环境里没有该变量)。

---

## 2. 已完成 (Done)

### 2.1 hy3 模型代理 (`:3640`)
- 文件: `cloudbase-proxy.js`
- 作用: 用 CloudBase SDK 签名转发到官方网关, 暴露 OpenAI 兼容端点, 支持 `hy3` / `hy3-preview`。
- 实测: `curl :3640/health` → `{"status":"ok","models":["hy3","hy3-preview"]}`
- 工具调用(tool_calls)已验证可用。
- 已修: `keepAliveTimeout` 拉到 61s(匹配上游超时), 尝试缓解流式约第 36 次请求后卡死。

### 2.2 auto 均衡路由器 (`:3650`)
- 文件: `auto-router.js` (纯 Node, 无外部依赖)
- 前端暴露虚拟模型 **`auto`**, OpenAI 兼容。
- **分类器**: 商汤 `6.7-flash-lite`(单次调用, 响应丢弃, 永不进入会话历史)。
- **可见回复全部走 hy3 通道**(干净, 无推理污染):
  - SIMPLE / STANDARD / COMPLEX → `hy3`
  - CODE → `hy3-preview`
- 跨 tier 自动 fallback。
- 响应剥离(三层): 入站 `cleanBody` / 流式 SSE `stripReasoning` / 非流式 `scrubResponse`, 删除 `reasoning` / `thinking` / `reasoning_content` 字段族, 防止推理链污染 Hermes 会话历史。
- key 自动从 `~/.hermes/.env` 读取。

### 2.3 Hermes 接入
- `custom_providers` 已加 `router` 项(`base_url: http://127.0.0.1:3650/v1`, `model: auto`)。
- `opencode-zen` 插件 `base_url` 改成本地 `:3650`(已备份 `__init__.py.bak`), 让 Hermes 默认走 auto。
- `model.default = auto`。

### 2.4 启动别名
- `~/.bashrc` 的 `hyu` 别名升级为**双服务幂等拉起**(先 hy3 代理 :3640, 再 auto 路由器 :3650)。

### 2.5 实测通过的验证
- 四类路由的 `X-Routed-Model` 标注正确(简单/标准/复杂→hy3, 代码→hy3-preview)。
- 非流式返回无 `reasoning` 字段, 正文干净。
- 直连商汤 / hy3 流式字段结构已查明。

---

## 3. 根因查明 (Bug 分析)

### 3.1 "压缩上下文卡 3 分钟" 的根因
**元凶 = 商汤 `6.7-flash-lite` 的流式输出方式。**
- 流式: 把**思维链 + 正文全部塞进 `delta.reasoning`**, 只在末尾才发一小段 `delta.content`。
- 直连会把每轮 ~90 个 reasoning chunk(每轮 300+ tokens)灌进会话历史。
- 那条会话历史涨到 **331 条消息**, Hermes 反复触发压缩、历史越大压缩越慢 → 死循环。

**修复方式**: 把商汤**移出路由表**, 只留作分类器(响应丢弃); 所有可见回复走 hy3(干净模型)。

### 3.2 hy3 流式 `reasoning_content` 字段
- hy3 流式用 `reasoning_content`(不是 `reasoning`) 发推理内容, 空串也会占位。
- 已在 `auto-router.js` 三处剥离点补删 `reasoning_content`。

### 3.3 hy3 代理流式卡死(约第 36 次)
- 现象: 数据全发完、发 `[DONE]`, 但 HTTP 连接不关闭, curl 一直等到 `--max-time` 才断。
- 疑似 Node HTTP keep-alive 复用故障。
- 缓解: `keepAliveTimeout=61000`。

---

## 4. 当前进度 / 未完成 (In Progress / TODO)

### 4.1 【待验证】auto 流式剥离 `reasoning_content` 后是否 0 泄漏
- `auto-router.js` 已加 `delete nc.delta.reasoning_content` 等三处。
- 重启 router 后, 验证命令发出但未拿到干净结果(流式正文条数为 0, 疑似触发 3.3 的卡死, 需 `--max-time` 配合确认)。

### 4.2 【待验证】hy3 代理 keepAliveTimeout 修复后是否不再卡死
- `cloudbase-proxy.js` 已改。
- 需跑 40 条以上连续流式请求确认不再在第 36 次左右卡住。

### 4.3 【建议】清理已污染的 331 条历史会话
- 历史里已累积大量推理链, 即便修复后压缩会短暂继续跑完。
- 建议新建会话或手动截断历史。

### 4.4 【可选】Hermes 侧 `custom:<name>` 动态引用有坑
- `-z` 非交互单次调用对 `custom:cloudbase` / `custom:router` 报 Unknown provider。
- 当前绕过方案: 改 `opencode-zen` 插件 base_url 指本地。WebUI 交互模式不受影响。

---

## 5. 改动文件清单

| 文件 | 动作 |
|---|---|
| `~/workspace/auto-router.js` | **新建**, 均衡路由器(含三层推理剥离) |
| `~/workspace/cloudbase-proxy.js` | 修改 `keepAliveTimeout` |
| `~/workspace/.sensenova_free_models.json` | 新建, 商汤 free 模型清单 |
| `~/.hermes/hermes-agent/plugins/model-providers/opencode-zen/__init__.py` | 修改 base_url → :3650 |
| `~/.hermes/hermes-agent/plugins/model-providers/opencode-zen/__init__.py.bak` | 备份 |
| `~/.bashrc` | `hyu` 别名升级为双服务幂等拉起 |

---

## 6. 一键验证命令(供复核)

```bash
cd ~/workspace
# 重启
pkill -f "node cloudbase-proxy.js"; pkill -f "node auto-router.js"
TCB_TOKEN=$(cat .tcb_token.tmp) nohup node cloudbase-proxy.js > cloudbase-proxy.log 2>&1 &
TCB_TOKEN=$(cat .tcb_token.tmp) nohup node auto-router.js   > auto-router.log   2>&1 &
sleep 2

# 健康检查
curl -s http://127.0.0.1:3640/health
curl -s http://127.0.0.1:3650/health

# 流式剥离验证 (期望 reasoning / reasoning_content 均为 0)
curl -s -N --max-time 40 -X POST http://127.0.0.1:3650/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}],"stream":true}' \
  | grep -c '"reasoning_content"'

# 连续流式压力(期望不卡死)
for i in $(seq 1 45); do
  curl -s -N --max-time 30 -X POST http://127.0.0.1:3650/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"model":"auto","messages":[{"role":"user","content":"ok"}],"stream":true}' > /dev/null
  echo "req=$i $(date +%s)"
done
```
