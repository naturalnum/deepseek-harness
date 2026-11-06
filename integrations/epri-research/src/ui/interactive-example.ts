import aimd from '../../examples/interactive-power/protocol.aimd';
import toml from '../../examples/interactive-power/protocol.toml';
import assigner from '../../examples/interactive-power/assigner.py';
import interaction from '../../examples/interactive-power/interaction.json';
export const interactiveExample={id:'power-data-quality-interactive',version:'1.0.0',title:'设备测点数据质量检查 · 交互示例',kind:'protocol',files:{'protocol.aimd':aimd,'protocol.toml':toml,'assigner.py':assigner,'interaction.json':JSON.stringify(interaction)}};
