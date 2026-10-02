# 截图

这个目录里的 png 是 `node test/shot.js` 拉真窗口截出来的，一共 13 张：

| 文件 | 内容 |
| --- | --- |
| `agent-01-empty.png` | 空白状态 |
| `agent-02-conversation.png` | 一次完整任务（工具调用 + 输出） |
| `agent-03-approval.png` | 危险命令确认弹窗 |
| `agent-04-settings.png` | 设置页（自定义接口） |
| `agent-05-terminal.png` | 终端输出 |
| `agent-06-login.png` | 登录页 |
| `agent-07-quota.png` | 额度详情 |
| `agent-08-settings-community.png` | 设置页（社区账号） |
| `agent-09-composer-selects.png` | 输入栏右侧的模型 / 推理强度下拉 |
| `agent-10-copy.png` | 消息复制按钮 + 右键菜单 |
| `agent-11-login-hides.png` | 登录成功后登录页必须收起（回归验收） |
| `agent-12-avatar.png` | 社区头像同步（含账号弹窗里的大号头像） |
| `agent-13-avatar-fallback.png` | 头像取不到时退回昵称首字 |

> 09~13 这五张不只是「好看」：每张都带一个断言，`SHOT_SCRIPT_RESULT` 里会打出来。
> 比如 09 会报 `model=wyzx-omni mopts=2 reason="" ropts=4`（模型确实同步下来了），
> 12 会报 `prefix=data:image/png;base64 side_img=true lg_img=true`（头像确实是主进程
> 转成 data: URL 再交给界面的）。改界面时它们就是回归测试，别当成装饰图删掉。

**为什么不提交到仓库**：GitHub 的接口只能提交文本，二进制文件传不上去。
README 里引用的图挂在 `https://download.wuyunsq.top/wuyun-maling/`，
改界面之后重新截一遍、上传到那里就行。

重新生成：

```
node test/shot.js                 # 全部 13 张
SHOT_ONLY=07-quota node test/shot.js   # 只截其中一张
SHOT_ONLY=09,10,11 node test/shot.js   # 逗号分隔可以多张
```

输出默认落在仓库外的 `_shots/`，确认没问题再拷进来。
