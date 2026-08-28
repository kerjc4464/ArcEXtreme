# ArcEXtreme

Dynamic DE_RLHF · SillyTavern 扩展 + Python 后端

短期池 BTB（2bit 饱和计数器 0/1/2/3）+ 长期库向量检索 + Rerank 精排 + 升华固化。

> 本仓库正在准备开源，当前为本地初始化阶段。

## 结构

- `index.js` / `src/` — 前端扩展（事件提炼 / SubAgent 裁判 / 路由 / 检索 / 注入）
- `ArcEXtreme-BackEnd/server.py` — FastAPI 后端（FAISS + SQLite `arcextreme.db` + `souls/`）
- `manifest.json` / `settings.html` / `style.css` — 扩展清单与面板
- `ARCHITECTURE.md` — 架构说明

## 流水线

```
提炼 → 裁判(SubAgent ±1/Skip) → 腾坑(prepare) → 路由(分桶) → 检索(含Y权重/回填) → 检索二次裁判(A1) → 精排 → 注入 → 升华(stuck≥阈值)
```

- 原事件 `Why` 500 字空间，SubAgent 增量 `Why` 70~120 字
- 长期库命中也会走二次裁判更新 2bit（A1，默认开启，可在“短期池 BTB”面板关闭）

## 本地开发

```bash
# 后端
cd ArcEXtreme-BackEnd
pip install -r requirements.txt
python server.py  # :9001

# 前端：SillyTavern → 扩展 → ArcEXtreme 面板配置 LLM/Embedding 后刷新
```

## 开源准备 TODO

- [ ] LICENSE
- [ ] 清理 secrets / 私有 souls 示例
- [ ] CI / 发布流程
- [ ] 远程仓库关联
