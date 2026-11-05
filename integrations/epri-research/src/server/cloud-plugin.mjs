import * as tools from '../../plugins/airalogy/index.mjs';
import * as skills from '../../plugins/deepscientist/index.mjs';
import * as workbench from '../../plugins/workbench/index.mjs';
export {openCloudStore} from './cloud-store.mjs';

export function install(kind,ctx) {
  if(!ctx.get('peAccount',false)||!ctx.get('epriResearch',false))throw new Error('Cloud research requires its original account service.');
  const contribution={tools,skills,workbench}[kind];
  if(!contribution)throw new Error('Unknown research contribution.');
  contribution.apply(ctx);
}
