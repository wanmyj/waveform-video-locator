# soundwave

监控视频声音波形定位工具。选中同一文件夹下若干个（时间轴基本连续的）视频文件，
在网页上看到它们拼接后的声音波形，用来快速定位突发声音（比如一声咳嗽）对应的画面位置。

## 依赖

- Node.js（或者直接用 GitHub Actions 打包出的 exe，见下方「打包 exe」）
- ffmpeg / ffprobe（不需要在 PATH 中，网页里可以指定所在文件夹）

## 使用

```
npm install
npm run mock      # 生成 mock/ 目录下的测试视频（静音 + 几段模拟咳嗽噪声）
node server.js    # 启动服务，默认端口 3334，可用 PORT 环境变量覆盖
```

打开 `http://localhost:3334`：

1. 在页面顶部填写「视频文件夹」和「ffmpeg 所在文件夹」（后者需要包含
   `ffmpeg.exe` / `ffprobe.exe`），点击「保存」。设置会写入运行目录下的
   `config.json`，下次启动自动带入。
2. 勾选要查看的视频文件，点击「加载所选文件的波形」
3. 滚轮左右平移波形，Ctrl+滚轮 或 +/- 按钮缩放
4. 点击或拖动波形定位播放位置；拖动过程中会悬浮显示对应时间点的画面预览
5. 播放时波形上的红色游标会跟随当前播放进度

## 打包 exe

仓库里的 GitHub Actions workflow（`.github/workflows/build-exe.yml`）可以手动
触发，在 Actions 页面选择 "Build exe" → "Run workflow"，构建完成后从该次
运行的 Artifacts 里下载 `soundwave-exe`（内含 `soundwave.exe`）分发给别人。
双击运行后打开 `http://localhost:3334` 即可，用法与上面一致。

本地也可以直接打包：

```
npm run build:exe   # 用 pkg 打包，产物在 dist/soundwave.exe
```

## 结构

- `server.js` — Express 服务，封装 ffmpeg/ffprobe 调用（文件列表、时长/偏移、
  拼接波形音频、视频流、缩略图截图），结果按文件名做磁盘缓存于 `cache/`；
  视频文件夹、ffmpeg 文件夹保存在运行目录下的 `config.json`
- `public/` — 前端页面，用 wavesurfer.js（CDN 引入）渲染波形
- `mock/` — 测试视频生成脚本及生成的素材
- `.github/workflows/build-exe.yml` — 手动触发，用 pkg 打包 Windows exe

## 已知限制

- 波形上暂未标出各源文件的分界线
- 缩略图缓存不会自动过期清理
- 文件夹路径靠手动输入，网页暂不提供系统级的文件夹选择对话框（浏览器出于
  安全限制无法把本地绝对路径交给服务端）
