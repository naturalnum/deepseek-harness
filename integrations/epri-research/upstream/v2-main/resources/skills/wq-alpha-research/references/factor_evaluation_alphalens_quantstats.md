# 因子评估：Alphalens + QuantStats

用于评估已有因子或策略收益序列。优先区分“因子预测能力”和“组合收益表现”。

## 1. Alphalens 适合回答

- 因子 RankIC/IC 是否稳定。
- 多空分层收益是否单调。
- 分位数组合换手是否过高。
- 不同行业/分组下是否稳定。

最小输入：

- `factor`: MultiIndex Series，index 通常是 date + asset。
- `pricing`: 宽表价格数据。
- `groupby`: 可选行业/板块分类。

典型流程：

```python
import alphalens as al

factor_data = al.utils.get_clean_factor_and_forward_returns(
    factor=factor,
    prices=prices,
    quantiles=5,
    periods=(1, 5, 10),
    groupby=industry_map,
)
al.tears.create_full_tear_sheet(factor_data)
```

## 2. QuantStats 适合回答

- 策略收益序列是否有稳定风险调整收益。
- 最大回撤、波动、胜率、月度表现。
- 与基准的比较报告。

典型流程：

```python
import quantstats as qs

qs.extend_pandas()
qs.reports.html(returns, benchmark=benchmark_returns, output="factor_report.html")
```

## 3. 判断标准

- IC 均值不够，必须看 IC t-stat、分年度稳定性和极端阶段。
- 分层收益要看单调性，而不是只看 top-bottom。
- 高 IC 但极高换手可能不可交易。
- 收益序列漂亮但没有因子分层验证，不能证明因子有效。

## 4. 输出建议

报告中明确列：

- 数据源、样本期、股票池、频率。
- 因子公式和方向。
- IC/RankIC、分层收益、换手、成本后表现。
- 失效场景和下一步修正。
