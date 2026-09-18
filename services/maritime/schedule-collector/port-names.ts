/** Search and display translations only. Carrier IDs and availability always come from the carrier. */
export interface PortName { readonly zh: string; readonly en: string; readonly country: string; readonly aliases: readonly string[] }
const rows = [
  ['上海','Shanghai','CN','上海港'],['上海洋山','Shanghai Yangshan','CN','洋山'],['宁波','Ningbo','CN','宁波舟山'],
  ['青岛','Qingdao','CN','青岛港'],['深圳','Shenzhen','CN','深圳港'],['盐田','Yantian','CN','盐田港'],['蛇口','Shekou','CN','蛇口港'],
  ['厦门','Xiamen','CN','厦门港'],['天津','Tianjin','CN','天津港'],['天津新港','Xingang','CN','新港'],['大连','Dalian','CN','大连港'],
  ['连云港','Lianyungang','CN',''],['福州','Fuzhou','CN',''],['广州','Guangzhou','CN','广州港'],['南沙','Nansha','CN','南沙港'],
  ['黄埔','Huangpu','CN',''],['湛江','Zhanjiang','CN',''],['香港','Hong Kong','HK','香港港'],
  ['温哥华','Vancouver','CA','温哥华港'],['温哥华','Vancouver','US','华盛顿州温哥华'],
  ['鲁珀特王子港','Prince Rupert','CA','鲁珀特港|鲁伯特港|鲁伯特王子港'],['蒙特利尔','Montreal','CA','蒙特利尔港|满地可'],
  ['哈利法克斯','Halifax','CA','哈利法克斯港'],['多伦多','Toronto','CA','多伦多港'],['卡尔加里','Calgary','CA',''],
  ['埃德蒙顿','Edmonton','CA',''],['温尼伯','Winnipeg','CA',''],['渥太华','Ottawa','CA',''],['魁北克','Quebec','CA',''],
  ['圣约翰','Saint John','CA','新不伦瑞克圣约翰'],['圣约翰斯','St Johns','CA','纽芬兰圣约翰斯'],
  ['洛杉矶','Los Angeles','US','洛杉矶港'],['长滩','Long Beach','US','长滩港'],['奥克兰','Oakland','US','美国奥克兰'],
  ['纽约','New York','US','纽约港'],['纽瓦克','Newark','US',''],['西雅图','Seattle','US',''],['塔科马','Tacoma','US',''],
  ['萨凡纳','Savannah','US','沙凡那'],['休斯顿','Houston','US',''],['诺福克','Norfolk','US',''],['查尔斯顿','Charleston','US',''],
  ['迈阿密','Miami','US',''],['巴尔的摩','Baltimore','US',''],['波士顿','Boston','US',''],['费城','Philadelphia','US',''],
  ['新奥尔良','New Orleans','US',''],['芝加哥','Chicago','US',''],['达拉斯','Dallas','US',''],['底特律','Detroit','US',''],
  ['釜山','Busan','KR','釜山港|Pusan'],['仁川','Incheon','KR',''],['新加坡','Singapore','SG',''],
  ['巴生港','Port Klang','MY','巴生|Port Kelang'],['丹戎帕拉帕斯','Tanjung Pelepas','MY',''],
  ['胡志明','Ho Chi Minh','VN','胡志明市'],['海防','Haiphong','VN','Hai Phong'],['林查班','Laem Chabang','TH',''],
  ['曼谷','Bangkok','TH',''],['雅加达','Jakarta','ID',''],['泗水','Surabaya','ID',''],['马尼拉','Manila','PH',''],
  ['东京','Tokyo','JP',''],['横滨','Yokohama','JP',''],['名古屋','Nagoya','JP',''],['大阪','Osaka','JP',''],['神户','Kobe','JP',''],
  ['高雄','Kaohsiung','TW',''],['基隆','Keelung','TW',''],['台中','Taichung','TW',''],
  ['鹿特丹','Rotterdam','NL',''],['汉堡','Hamburg','DE',''],['不来梅哈芬','Bremerhaven','DE',''],['安特卫普','Antwerp','BE',''],
  ['费利克斯托','Felixstowe','GB',''],['南安普顿','Southampton','GB',''],['勒阿弗尔','Le Havre','FR',''],
  ['巴塞罗那','Barcelona','ES',''],['瓦伦西亚','Valencia','ES',''],['热那亚','Genoa','IT',''],['比雷埃夫斯','Piraeus','GR',''],
  ['伊斯坦布尔','Istanbul','TR',''],['格但斯克','Gdansk','PL',''],['杰贝阿里','Jebel Ali','AE',''],['迪拜','Dubai','AE',''],
  ['达曼','Dammam','SA',''],['吉达','Jeddah','SA',''],['苏哈尔','Sohar','OM',''],['塞拉莱','Salalah','OM',''],
  ['卡拉奇','Karachi','PK',''],['科伦坡','Colombo','LK',''],['金奈','Chennai','IN',''],['蒙德拉','Mundra','IN',''],
  ['那瓦舍瓦','Nhava Sheva','IN','那瓦西瓦'],['悉尼','Sydney','AU',''],['墨尔本','Melbourne','AU',''],
  ['布里斯班','Brisbane','AU',''],['弗里曼特尔','Fremantle','AU',''],['阿德莱德','Adelaide','AU',''],
  ['奥克兰','Auckland','NZ','新西兰奥克兰'],['陶朗加','Tauranga','NZ',''],['桑托斯','Santos','BR',''],
  ['布宜诺斯艾利斯','Buenos Aires','AR',''],['卡亚俄','Callao','PE',''],['曼萨尼约','Manzanillo','MX',''],
  ['韦拉克鲁斯','Veracruz','MX',''],['卡塔赫纳','Cartagena','CO',''],['德班','Durban','ZA',''],
  ['开普敦','Cape Town','ZA',''],['蒙巴萨','Mombasa','KE',''],['达累斯萨拉姆','Dar es Salaam','TZ',''],['拉各斯','Lagos','NG',''],
] as const;
export const portNames: readonly PortName[] = rows.map(([zh,en,country,aliases])=>({zh,en,country,aliases:aliases?aliases.split('|'):[]}));
const normalize=(value:string)=>value.trim().toLocaleLowerCase().replace(/[.,\s]+/gu,' ');
export function searchPortNames(text:string, country?:string|null): readonly PortName[] {
  const query=normalize(text);
  return portNames.filter(port=>(!country||port.country===country)&&(!query||[port.zh,port.en,...port.aliases].some(name=>normalize(name).includes(query))));
}
export function exactPortName(text:string,country?:string|null): PortName|null {
  const query=normalize(text.split(',')[0]||'');
  const matches=portNames.filter(port=>(!country||port.country===country)&&[port.zh,port.en,...port.aliases].some(name=>normalize(name)===query));
  return matches.length===1?matches[0]??null:null;
}
export function portLookup(text:string,countryCode:string|null): {text:string;countryCode:string|null} {
  const port=exactPortName(text,countryCode);
  // English queries retain their original country scope, including ambiguity.
  return port&&/\p{Script=Han}/u.test(text)?{text:port.en,countryCode:port.country}:{text,countryCode};
}
