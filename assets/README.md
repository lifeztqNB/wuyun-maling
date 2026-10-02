# assets —— 图片资源的文本版本

这里放的是**界面 logo 与打包图标的 base64 文本**，不是可直接使用的图片。

## 为什么不用真图片

这个仓库的提交是通过 GitHub 接口完成的，而接口只能提交**文本**内容 ——
二进制文件传不上去。为了不让「克隆下来少了两个 png，跑起来没 logo」这种事发生，
图片就以 base64 文本存一份，构建和启动前还原成真文件。

## 怎么用

不用手动管，`npm start` 和 `npm run dist` 会先自动还原：

```
node scripts/assets.js            # 还原成 renderer/logo.png 等真文件
node scripts/assets.js --encode   # 反向：换了 logo 之后，把真文件重新编码回这里
```

还原出来的文件是**构建产物**，已经在 `.gitignore` 里排除，别手工改（会被覆盖）：

| 文本源 | 还原到 |
| --- | --- |
| `logo-256.png.b64` | `renderer/logo.png`（登录页 / 空状态） |
| `logo-64.png.b64` | `renderer/logo-sm.png`（标题栏） |
| `icon.ico.b64` | `build/icon.ico`（exe 图标） |

## 如果你更希望仓库里放真图片

把 `.gitignore` 里那三行删掉，然后正常 `git add` 提交即可 —— 文本版本留着也不冲突
（`assets.js --encode` 可以用来同步）。只是想说明一下：现在这种做法是**被工具限制逼出来的**，
不是设计上的偏好。
