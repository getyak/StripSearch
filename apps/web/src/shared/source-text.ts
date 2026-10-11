/** Presentation only: never changes retained sources or evidence quotations. */
export function readableSourceText(original:string):string {
 return original.replace(/<(script|style|head|nav|footer|header|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&#(x[0-9a-f]+|[0-9]+);/gi,(match,value:string)=>{
  const code=value[0]?.toLowerCase()==='x'?Number.parseInt(value.slice(1),16):Number.parseInt(value,10);
  return code>0&&code<=0x10ffff?String.fromCodePoint(code):match;
 }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g,(_match,entity:string)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[entity]??'')).replace(/\s+/g,' ').trim();
}
