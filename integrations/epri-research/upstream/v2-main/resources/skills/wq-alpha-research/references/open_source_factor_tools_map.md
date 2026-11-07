# 开源金融因子工具地图

本文件用于选择工具，不要求默认安装所有依赖。除非用户明确要求实现或运行，否则先把工具作为 reference 和方案来源。

| 工具 | 适用任务 | 默认策略 |
|---|---|---|
| Qlib | 完整量化研究流水线、Alpha158/Alpha360、模型训练、回测 | 可选重型依赖；适合项目级研究 |
| Alphalens Reloaded | 因子 IC、分层收益、换手、tear sheet | 推荐作为因子评估首选 |
| QuantStats | 收益序列分析、风险指标、HTML 报告 | 推荐作为策略/组合报告首选 |
| AKShare | A 股、宏观、商品等中文数据 | 可选数据连接器 |
| Tushare | A 股行情和基础数据，通常需要 token | 可选数据连接器 |
| OpenBB | 多市场数据聚合和 API 层 | AGPL；不要内置源码，只作为用户可选连接器 |
| PyPortfolioOpt | 均值方差、Black-Litterman、HRP | 组合构建可选 |
| Riskfolio-Lib | CVaR、风险预算、复杂约束优化 | 高级风险/组合可选 |
| gplearn | 符号回归和公式搜索 | 公式因子探索可选 |
| AlphaForge | 自动 alpha 搜索、遗传/深度方法 | 依赖较旧，只提炼思路 |
| RD-Agent | Agent 化因子和模型研发 | Linux/重型流程；高级自动挖掘参考 |
| QuantaAlpha | LLM 自进化因子挖掘 | 提炼轨迹级 SOP，默认不运行 |

## 选择规则

1. 用户只要候选因子：读 `general_factor_research_sop.md`，必要时读 `symbolic_formula_mining.md`。
2. 用户要评估一个已有因子：读 `factor_evaluation_alphalens_quantstats.md`。
3. 用户要真实数据：读 `data_connectors_openbb_akshare_tushare.md`。
4. 用户要完整项目流水线：读 `qlib_research_workflow.md`。
5. 用户要自动挖掘：读 `agentic_alpha_mining_rd_agent_quantaalpha.md`。
6. 用户要组合优化或风险控制：读 `portfolio_risk_optimization.md`。
7. 用户明确说 WorldQuant / BRAIN / WQ Alpha：回到 `SKILL.md` 的 WQ 字段、表达式、提交和 memory 流程。

## 许可与打包边界

- OpenBB 是 AGPL，不应把源码直接复制进商业客户端。
- vectorbt 当前许可包含 Commons Clause，不应作为默认商业打包依赖。
- Qlib、RD-Agent、AKShare、PyPortfolioOpt 等更适合作为可选依赖，但仍应保留第三方许可说明。
- 默认交付应是 SOP、脚本模板和用户环境运行建议，而不是悄悄安装重型依赖。
