# 配电负荷异常识别 QA 技术报告

# 摘要

配电负荷数据质量核查中，分析人员需要在不依赖现场标注的条件下判断哪些单变量负荷取值应当被标记为疑似异常。这类场景通常缺少可信的异常标签，只能依靠记录自身的取值分布判断；同时样本量往往很小，个别极端取值会明显影响均值与标准差。因此直接用基于均值与标准差的偏离度量量化时，估计可能受极端值影响，需要明确校准集与验证集边界及复核方式。为此需要解决三项关键挑战：第一，在校准数据很少时获得抗极端值干扰的稳健中心与尺度；第二，在阈值事先固定、不使用验证标签调参的前提下产生疑似异常标记；第三，给出可核对的标记效果指标以支撑人工核查。

针对上述挑战，本项目构建了由校准、标记与计数三个环节衔接的技术链。第一，针对小样本下尺度估计不稳健的问题，改以中位数作为稳健中心、以中位数绝对偏差作为稳健尺度，二者仅由16条校准记录估计，避免同批数据既估计尺度又参与判定而产生尺度泄漏，得到抗极端值干扰的稳健尺度估计值。第二，针对标记过程需要可复现的问题，采用修正标准分数作为标记量，以比例因子0.6745折算偏离程度，阈值事先固定为分数的绝对值严格大于3.5，并在尺度为零时拒绝计算而不自行替换尺度，据此对12条验证记录产生疑似异常标记清单。第三，针对标记效果需要可核对的问题，依据独立标签以混淆矩阵统计各项计数，计算精确率、召回率、F1与误报数，并以基于均值与标准差的普通标准分数作对照。三个环节前序输出依次作为后续输入，使整条技术链可逐步复核。

在上述技术链上，本项目在28条人工构造的模拟参考记录（16校准、12验证）上完成计算。修正标准分数方法在12条验证记录上得到 F1为0.80、误报数1，满足任务规定的对该模拟算例的 F1与误报条件。作为补充对照，普通标准分数在同一批记录上 F1约为0.667、误报数为2；两种配置同时改变中心与尺度、比例因子与阈值，该差异只作并列对照，不能单独归因于稳健尺度。总体来看，项目形成了一条可复现、可逐步核对的单变量配电负荷疑似异常标记流程与评价链，适用边界为单变量、小样本与事先固定阈值，疑似异常标记不等于故障或窃电认定。后续可在更多算例与标注数据上复核尺度与阈值。

**关键词：** 配电负荷，数据质量核查，中位数绝对偏差，修正标准分数，混淆矩阵

# Abstract

Distribution-load data quality checks require analysts to decide, without field labels, which univariate load values should be flagged as suspected anomalies. Such settings usually lack trustworthy anomaly labels and can only be judged from the distribution of the records themselves; at the same time samples are often very small, so a few extreme values can markedly shift the mean and standard deviation. Consequently, when deviation is quantified directly with a mean- and standard-deviation-based measure, the estimate may be affected by extreme values, and the boundary between calibration and validation data and the way flagging results are reviewed must be made explicit. This work therefore addresses three key challenges. First, obtaining a robust centre and scale that resist extreme values when calibration data are scarce. Second, producing suspected-anomaly flags under a threshold fixed in advance and without tuning on validation labels. Third, providing checkable flagging-effect metrics to support further manual inspection.

To meet these challenges, this work builds a technical chain that links calibration, flagging and counting. First, to address unstable scale estimation in small samples, the median is used as the robust centre and the median absolute deviation as the robust scale, both estimated only from 16 calibration records, so that the same data are not used both to estimate the scale and to decide flags; this yields a robust scale that resists extreme values. Second, to make flagging reproducible, the modified z-score is used as the flagging quantity, with a scaling factor of 0.6745, a threshold fixed in advance as an absolute value strictly greater than 3.5, and a refusal to compute when the scale is zero rather than substituting another scale, producing a suspected-anomaly list for the 12 validation records. Third, to make the flagging effect checkable, a confusion matrix is used with independent labels to count each cell and to compute precision, recall, F1 and the number of false positives, with the ordinary z-score based on mean and standard deviation as a comparison. Each stage feeds its output into the next, so the whole chain can be checked step by step.

On this chain, the work was computed on 28 artificially constructed simulated reference records (16 calibration, 12 validation). On the 12 validation records the modified z-score method reached an F1 of 0.80 with 1 false positive, meeting the task's F1 and false-positive conditions for this simulated case. As a supplementary comparison, the ordinary z-score reached an F1 of about 0.667 with 2 false positives on the same records; because the two configurations change the centre/scale, the scaling factor and the threshold together, the difference is only a side-by-side comparison and cannot be attributed to the robust scale alone. Overall, the project formed a reproducible, step-checkable flow for flagging suspected anomalies in univariate distribution load and an evaluation chain, whose applicable boundary is univariate data, small samples and a threshold fixed in advance; a suspected-anomaly flag only means further inspection is needed and does not amount to a fault or electricity-theft determination. Future work can review the robust scale and threshold on more cases and on labelled data where available.

**Keywords:** distribution load, data quality check, median absolute deviation, modified z-score, confusion matrix

# 1 摘要段落验证

本测试仅检验真实双语摘要段落转换，不代表完整报告已编译。

# 参考文献
[1] 测试作者. 段落兼容验证[M]. 北京: 测试出版社, 2026.
