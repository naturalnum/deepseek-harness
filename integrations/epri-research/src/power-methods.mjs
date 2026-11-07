import qualityAimd from '../examples/interactive-power/protocol.aimd';
import qualityToml from '../examples/interactive-power/protocol.toml';
import qualityPython from '../examples/interactive-power/assigner.py';
import qualityCharts from '../examples/interactive-power/interaction.json';
import calibrationAimd from '../examples/power-methods/calibration/protocol.aimd';
import calibrationToml from '../examples/power-methods/calibration/protocol.toml';
import calibrationPython from '../examples/power-methods/calibration/assigner.py';
import forecastAimd from '../examples/power-methods/forecast-assessment/protocol.aimd';
import forecastToml from '../examples/power-methods/forecast-assessment/protocol.toml';
import forecastPython from '../examples/power-methods/forecast-assessment/assigner.py';

const method=(id,title,description,keywords,limitations,aimd,toml,python,charts,qcField)=>{const metadata={description,keywords,limitations,...(qcField?{qcField}:{})};return {id,version:'1.0.0',title,kind:'protocol',metadata,files:{'protocol.aimd':aimd,'protocol.toml':toml,'assigner.py':python,'interaction.json':JSON.stringify(charts),...(id==='power-data-quality-interactive'?{}:{'method.json':JSON.stringify(metadata)})}};};
export const powerMethods=[
  method('power-data-quality-interactive','设备测点数据质量检查','按应有采样数和有效采样数计算缺失率，逐测点绘图。',['数据质量','测点','缺失率','采样','有效点'],'仅评价采样完整性，不作设备故障或状态诊断。',qualityAimd,qualityToml,qualityPython,qualityCharts),
  method('power-linear-calibration','电力测量通道线性标定','输入标准值与测量值，拟合斜率、截距、R²，按本次残差限值质控。',['标定','传感器','标准值','校准','线性拟合'],'限值由试验要求确定；残差通过不代表满足整套检定规程，须核对量纲、量程与重复性。',calibrationAimd,calibrationToml,calibrationPython,{charts:[{id:'errors',title:'各测量点示值误差',table:'points',label:'point',value:'error'}]},'qc_pass'),
  method('power-forecast-assessment','负荷预测结果评估','对齐实际负荷和已有预测值，计算 MAE、RMSE 并绘制误差。',['负荷预测','预测评估','预测误差','MAE','RMSE'],'评价已有预测值，不训练模型；人工核对时刻、单位、独立测试时段及数据泄漏。',forecastAimd,forecastToml,forecastPython,{charts:[{id:'errors',title:'各时刻负荷预测绝对误差',table:'samples',label:'time',value:'absolute_error'}]},'qc_pass')
];
