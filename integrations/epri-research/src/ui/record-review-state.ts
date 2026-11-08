import {useCallback,useRef,useState} from 'react';

/** Keep the review event guard current before React commits its visible dirty and saving state.
 * @returns Stable editor notifications and the current request guard; this grants no approval. */
export function useRecordReviewState(){
  const [dirty,showDirty]=useState(false),[saving,showSaving]=useState(false);
  const current=useRef({dirty:false,saving:false});
  const setDirty=useCallback((value:boolean)=>{current.current.dirty=value;showDirty(value);},[]);
  const setSaving=useCallback((value:boolean)=>{current.current.saving=value;showSaving(value);},[]);
  const isReviewBlocked=useCallback(()=>current.current.dirty||current.current.saving,[]);
  return {dirty,saving,setDirty,setSaving,isReviewBlocked};
}
