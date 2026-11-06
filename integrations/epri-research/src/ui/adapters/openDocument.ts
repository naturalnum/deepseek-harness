export function useLocalFilePreview(_workspace?: string) {
  return async (path: string,_unused?:unknown,document?:{title:string;content?:string},_options?:unknown) => {
    window.dispatchEvent(
      new CustomEvent("research-open-document", { detail: document?.content!==undefined?{...document,id:path}:path }),
    );
  };
}
