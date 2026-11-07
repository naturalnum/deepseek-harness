/** Resolve the current account's injected provider; cloud mode never falls back to local administrator credentials. */
export function cloudResearch(ctx) {
  const account = ctx.get('peAccount', false);
  if (!account) {
    if(ctx.get('peAuth',false))throw new Error('科研服务缺少当前账号作用域，不能使用本地管理员连接。');
    return undefined;
  }
  const provider = ctx.get('cloudResearch', false);
  if (!provider || provider.binding !== account) throw new Error('科研服务尚未接入当前账号。');
  provider.assertCurrent();
  return provider;
}
