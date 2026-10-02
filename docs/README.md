# 截图

这个目录里的 png 是 `node test/shot.js` 拉真窗口截出来的，一共 8 张：

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

**为什么不提交到仓库**：GitHub 的接口只能提交文本，二进制文件传不上去。
README 里引用的图挂在 `https://download.wuyunsq.top/wuyun-maling/`，
改界面之后重新截一遍、上传到那里就行。

重新生成：

```
node test/shot.js                 # 全部 8 张
SHOT_ONLY=07-quota node test/shot.js   # 只截其中一张
```

输出默认落在仓库外的 `_shots/`，确认没问题再拷进来。
