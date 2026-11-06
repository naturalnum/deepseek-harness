// Shared input projection: computed cells never become inputs to their own next run.
export function stripCalculated(run,targets){
  const input=structuredClone(run);
  for(const target of targets){
    const [name,column]=target.split('.');
    if(column)for(const row of input.tables[name] || [])delete row[column];
    else {delete input.values[name];delete input.tables[name];}
  }
  return input;
}
