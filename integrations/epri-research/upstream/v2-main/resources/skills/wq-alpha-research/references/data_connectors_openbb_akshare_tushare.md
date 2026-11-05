# 数据连接器：OpenBB / AKShare / Tushare

用于选择金融数据入口。默认不自动下载大量数据，不保存 token，不把商业或登录凭证写入日志。

## 1. OpenBB

适合多市场、多资产、多数据源的统一入口。注意 OpenBB 是 AGPL，作为可选用户环境连接器使用，不直接内置源码。

示例：

```python
from openbb import obb

df = obb.equity.price.historical("AAPL").to_dataframe()
```

适用：

- 美股行情、公司数据、宏观、ETF、期权等跨数据源查询。
- 用户本地已经安装并接受其许可。

## 2. AKShare

适合中文金融数据、A 股、宏观、商品等快速查询。

示例：

```python
import akshare as ak

df = ak.stock_zh_a_hist(
    symbol="000001",
    period="daily",
    start_date="20200101",
    end_date="20241231",
    adjust="qfq",
)
```

适用：

- A 股价格和基础数据。
- 中国宏观、基金、债券、商品等数据探索。

## 3. Tushare

适合 A 股结构化数据，但通常需要用户 token。

示例：

```python
import tushare as ts

pro = ts.pro_api("YOUR_TOKEN")
df = pro.daily(ts_code="000001.SZ", start_date="20200101", end_date="20241231")
```

## 4. 数据使用 SOP

1. 先记录数据源和接口版本。
2. 明确复权方式、交易日历、缺失值、停牌处理。
3. 对财报/公告类字段记录可得时间，不得使用未来数据。
4. 不确定字段含义时，只能给出待确认结论。
