# 素材来源与授权 / Asset provenance & licensing

**中文**

本仓库的**代码**（`lib/`、`assets/widget.js`、`test/`、`tools/`）以
[MIT License](../LICENSE) 发布。

`assets/` 下的**媒体素材**（12 份 `.webm` / `.mp3` / `.png`，即开场/待机/动作/
跑出/开盖/拖动等动画与三份音效、一张钢盆贴图）由项目作者提供、随仓库分发：

- `basin.png`（钢盆）为 AI 生成图片，分发前已裁去生成水印并收紧到本体包围盒；
- 各 `.webm` 均为带 alpha 透明通道的素材，其中部分由作者提供的原始文件
  经 `-c copy` 无损搬运 / 转码而来（详见 [CHANGELOG.md](CHANGELOG.md) 的素材表）。

这些素材仅随本项目（作为 DSH 的装饰性挂件）分发。若你是其中任何一份素材的
权利人、认为不应被再分发，请开一个 issue，我们会尽快处理。

**English**

The **code** in this repository (`lib/`, `assets/widget.js`, `test/`, `tools/`)
is released under the [MIT License](../LICENSE).

The **media assets** under `assets/` (the 12 `.webm` / `.mp3` / `.png` files —
the opener/idle/action/run-out/open-lid/drag animations, three sound effects
and the basin sprite) were provided by the project author and are distributed
with this repository:

- `basin.png` is an AI-generated image; the generator watermark was cropped off
  and the sprite tightened to its bounding box before shipping;
- the `.webm` clips are alpha-enabled assets, some of them byte-copied
  (`-c copy`) or transcoded from originals provided by the author (see the
  asset table in [CHANGELOG.md](CHANGELOG.md)).

They are distributed solely as part of this decorative DSH widget. If you are
the rights holder of any asset and believe it should not be redistributed,
please open an issue and we will take it down promptly.
