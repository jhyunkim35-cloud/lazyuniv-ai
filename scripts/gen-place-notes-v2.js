const fs = require('fs');
const path = require('path');
const VAULT = 'C:/Users/김준현/Documents/Obsidian Vault/50 Life/맛집';

const INSTA = [
  {name:'더바움 경복궁점',type:'카페·디저트',area:'서울/종로·을지로·중구',addr:'종로구 체부동 44'},
  {name:'MIDNIGHT PLEASURE',type:'카페·디저트',area:'서울/마포·홍대·연남',addr:'마포구 연남동 241-18'},
  {name:'고스트블랙 연남',type:'양식',area:'서울/마포·홍대·연남',addr:'마포구 연남동 383-35'},
  {name:'카츠메',type:'일식당',area:'서울/성수·건대',addr:'성동구 성수동1가 668-137 지하1층'},
  {name:'세야스시',type:'일식·스시',area:'서울/강남',addr:'강남구 청담동 20-20'},
  {name:'이테르',type:'양식·이탈리안',area:'서울/종로·을지로·중구',addr:'중구 소공동 117 지하1층'},
  {name:'페피트',type:'양식',area:'서울/강남',addr:'강남구 청담동 121-45'},
  {name:'호루몬',type:'일식당',area:'서울/강남',addr:'강남구 신사동 631-17 2층'},
  {name:'리차드1010',type:'멕시코·남미',area:'지방/기타',addr:'대구 중구 동인동4가 397-3'},
  {name:'마토미',type:'양식',area:'서울/용산·이태원',addr:'용산구 한강로1가 11-2'},
  {name:'뿡어당 성신여대본점',type:'베이커리',area:'서울/기타',addr:'성북구 동선동2가 308'},
  {name:'취즈 모란점',type:'일식·이자카야',area:'경기',addr:'성남시 중원구 성남동 3586'},
  {name:'재인',type:'카페·디저트',area:'서울/용산·이태원',addr:'용산구 한남동 683-47 2층'},
  {name:'미림양장 선릉점',type:'요리주점',area:'서울/강남',addr:'강남구 대치동 896-16 지하1층'},
  {name:'신비주막',type:'요리주점',area:'서울/기타',addr:'송파구 방이동 59-11'},
  {name:'더파이브올스',type:'바',area:'서울/마포·홍대·연남',addr:'마포구 서교동 328-49 반지하'},
  {name:'쿠케리',type:'양식·이탈리안',area:'경기',addr:'인천 연수구 송도동 312-1'},
  {name:'콘피에르 셀렉션 롯데월드몰점',type:'양식',area:'서울/기타',addr:'송파구 신천동 29 6층'},
  {name:'마리오네',type:'양식·이탈리안',area:'서울/성수·건대',addr:'성동구 성수동2가 299-50'},
  {name:'버거스낵',type:'버거',area:'서울/용산·이태원',addr:'용산구 이태원동 565'},
  {name:'피읖 제페니즈다이닝',type:'요리주점',area:'서울/성수·건대',addr:'광진구 중곡동 647-19'},
  {name:'이시즈에',type:'일식·이자카야',area:'서울/성수·건대',addr:'광진구 중곡동 647-20'},
  {name:'해금서가',type:'문화·서점',area:'서울/강남',addr:'서초구 반포동 103-4 B1'},
  {name:'오퍼 카페',type:'카페·디저트',area:'서울/마포·홍대·연남',addr:'마포구 서교동 355-3'},
  {name:'대패감성 잠실본점',type:'한식·고기',area:'서울/기타',addr:'송파구 잠실동 208-4'},
  {name:'디저티스트',type:'카페·디저트',area:'서울/기타',addr:'송파구 송파동 33'},
  {name:'미레이',type:'카페·디저트',area:'서울/종로·을지로·중구',addr:'중구 회현동2가 31-1'},
  {name:'쿠로마구로',type:'일식당',area:'경기',addr:'성남시 분당구 정자동 174-1'},
  {name:'꼬끼오 장작구이',type:'한식',area:'서울/강남',addr:'강남구 역삼동 827-46'},
  {name:'전통술 박물관 산사원',type:'문화·체험',area:'경기',addr:'포천시 화현면 화현리 511'},
  {name:'온택',type:'일식당',area:'서울/용산·이태원',addr:'용산구 후암동 244-56 2층'},
  {name:'키오스크',type:'카페·디저트',area:'서울/마포·홍대·연남',addr:'마포구 망원동 57-194'},
  {name:'크치치킨 회기점',type:'치킨',area:'서울/기타',addr:'동대문구 회기동 60-93'},
  {name:'라프레플루트 성수',type:'카페·디저트',area:'서울/성수·건대',addr:'성동구 성수동1가 685-495 2층'},
  {name:'틸데',type:'카페·디저트',area:'서울/용산·이태원',addr:'용산구 남영동 59-2 2층'},
  {name:'슈안',type:'중식',area:'서울/성수·건대',addr:'광진구 군자동 469-10 2층'},
  {name:'무심',type:'카페·디저트',area:'서울/용산·이태원',addr:'용산구 후암동 105-109'},
  {name:'술비',type:'요리주점',area:'서울/종로·을지로·중구',addr:'종로구 혜화동 163-33'},
  {name:'아리계곡',type:'요리주점',area:'서울/강남',addr:'강남구 역삼동 817-23'},
  {name:'아라리 북촌',type:'카페·디저트',area:'서울/종로·을지로·중구',addr:'종로구 가회동 31-65'},
  {name:'새로이',type:'요리주점',area:'서울/성수·건대',addr:'광진구 화양동 94-1'},
  {name:'카페제이',type:'카페·디저트',area:'서울/기타',addr:'강동구 고덕동 294-1'},
  {name:'OFZ 성수',type:'카페·디저트',area:'서울/성수·건대',addr:'성동구 성수동2가 316-24'},
  {name:'천향원 명동점',type:'중식',area:'서울/종로·을지로·중구',addr:'중구 소공동 81 소공빌딩 2층'},
  {name:'기네스브릿지',type:'바·맥주',area:'서울/용산·이태원',addr:'용산구 한남동 272-3'},
  {name:'세르클 한남 본점',type:'카페·브런치',area:'서울/용산·이태원',addr:'용산구 한남동 737-23 4층'},
  {name:'생텀',type:'카페·디저트',area:'서울/용산·이태원',addr:'용산구 한남동 657-95'},
  {name:'목단가옥갤러리',type:'카페·갤러리',area:'서울/용산·이태원',addr:'용산구 한남동 683-74'},
];

const GOTO = [
  {name:'가야가야',type:'일식·라멘',area:'서울/마포·홍대·연남',addr:'마포구 서교동 395-171'},
  {name:'지미스테이블',type:'양식',area:'서울/기타',addr:'강동구 길동 363-15'},
  {name:'포티드',type:'카페·디저트',area:'서울/기타',addr:'서대문구 창천동 5-58'},
  {name:'해온',type:'카페·티',area:'서울/종로·을지로·중구',addr:'종로구 화동 45'},
  {name:'마망젤라또 성수점',type:'카페·아이스크림',area:'서울/성수·건대',addr:'성동구 성수동2가 315-18'},
  {name:'브루잉 세레모니',type:'카페·디저트',area:'서울/성수·건대',addr:'성동구 성수동2가 315-27'},
  {name:'비어도',type:'바·맥주',area:'서울/성수·건대',addr:'성동구 성수동2가 565-5 2층'},
  {name:'소복갈비',type:'한식·고기',area:'지방/기타',addr:'충남 예산군 예산읍 예산리 210-10'},
  {name:'모찌방',type:'카페·디저트',area:'서울/강남',addr:'강남구 대치동 905-21'},
  {name:'후토시 대치본점',type:'일식당',area:'서울/강남',addr:'강남구 대치동 316 은마종합상가'},
  {name:'명월집',type:'한식·고기',area:'지방/기타',addr:'강원 춘천시 퇴계동 1170-6'},
  {name:'김수사',type:'일식당',area:'서울/강남',addr:'강남구 논현동 5-13 지하1층'},
  {name:'도조&만쥬 빈티지샵',type:'구제의류',area:'서울/마포·홍대·연남',addr:'마포구 서교동 366-10 지하1층'},
  {name:'BOOMBOX 충무로점',type:'바·맥주',area:'서울/종로·을지로·중구',addr:'중구 필동1가 21-2'},
  {name:'헤트라스 한남',type:'화장품·향수',area:'서울/용산·이태원',addr:'용산구 한남동 739-8'},
  {name:'리듬앤버거',type:'버거',area:'경기',addr:'성남시 분당구 삼평동 660'},
  {name:'데이릿 현대백화점 판교점',type:'한식',area:'경기',addr:'성남시 분당구 백현동 541 지하1층'},
  {name:'카페 이로',type:'카페·디저트',area:'서울/강남',addr:'서초구 서초동 1555-2'},
  {name:'영울장인',type:'한식',area:'경기',addr:'성남시 수정구 태평동 6107'},
  {name:'바마셀',type:'카페·디저트',area:'서울/용산·이태원',addr:'용산구 원효로1가 38-3'},
  {name:'컨트리보이',type:'베이커리',area:'서울/강남',addr:'서초구 방배동 856-22'},
  {name:'라이프브레드 방배본점',type:'베이커리',area:'서울/강남',addr:'서초구 방배동 883-25'},
  {name:'mlc.',type:'카페·디저트',area:'서울/마포·홍대·연남',addr:'마포구 연남동 241-51 지1층'},
  {name:'올웨이즈어거스트로스터스',type:'카페·디저트',area:'서울/마포·홍대·연남',addr:'마포구 망원동 415-53'},
  {name:'파드레',type:'베이커리',area:'서울/기타',addr:'강서구 등촌동 682-2'},
  {name:'러시아케익',type:'베이커리',area:'서울/종로·을지로·중구',addr:'중구 광희동1가 134'},
  {name:'페르시안궁전',type:'인도·중동음식',area:'서울/종로·을지로·중구',addr:'종로구 명륜2가 121-1'},
  {name:'종로 희희',type:'일식·우동',area:'서울/종로·을지로·중구',addr:'종로구 효제동 19-1'},
  {name:'크래킹커피 판교백현점',type:'카페·브런치',area:'경기',addr:'성남시 분당구 백현동 583-2'},
  {name:'정면국수',type:'한식·국수',area:'서울/성수·건대',addr:'광진구 화양동 32-17'},
  {name:'하쿠텐라멘',type:'일식·라멘',area:'서울/마포·홍대·연남',addr:'마포구 연남동 387-6 반지하'},
  {name:'무겐스위치',type:'일식·라멘',area:'서울/마포·홍대·연남',addr:'마포구 연남동 390-51'},
  {name:'라운지 클라리멘토',type:'카페·디저트',area:'서울/마포·홍대·연남',addr:'마포구 서교동 379-9'},
  {name:'강동원',type:'중식',area:'서울/마포·홍대·연남',addr:'마포구 망원동 453-43'},
  {name:'비파티세리 공덕점',type:'베이커리',area:'서울/마포·홍대·연남',addr:'마포구 공덕동 105-67'},
  {name:'팟카파우',type:'태국음식',area:'서울/용산·이태원',addr:'용산구 용산동2가 신흥시장 2층'},
  {name:'타파코파 용산본점',type:'스페인음식',area:'서울/용산·이태원',addr:'용산구 한강로1가 231-12'},
  {name:'더정 우롱티프로젝트 서촌본점',type:'카페·티',area:'서울/종로·을지로·중구',addr:'종로구 체부동 42'},
  {name:'차수시간',type:'카페·티',area:'서울/종로·을지로·중구',addr:'종로구 적선동 80'},
  {name:'더판',type:'일식당',area:'경기',addr:'수원시 팔달구 장안동 119-1'},
  {name:'베통 성수',type:'카페·디저트',area:'서울/성수·건대',addr:'성동구 성수동2가 315-47'},
  {name:'탐광',type:'일식당',area:'서울/성수·건대',addr:'성동구 성수동2가 315-24'},
  {name:'헤키',type:'일식·돈가스',area:'서울/마포·홍대·연남',addr:'마포구 망원동 379-25'},
  {name:'멘야비토리',type:'일식·라멘',area:'경기',addr:'성남시 수정구 신흥동 4101'},
  {name:'일백식혜',type:'카페·디저트',area:'경기',addr:'성남시 분당구 정자동 86-6'},
  {name:'단막 홍대합정점',type:'한식·곱창',area:'서울/마포·홍대·연남',addr:'마포구 서교동 400-24'},
  {name:'이짜',type:'양식·이탈리안',area:'서울/성수·건대',addr:'성동구 성수동2가 299-13'},
  {name:'준수방키친',type:'양식·이탈리안',area:'서울/종로·을지로·중구',addr:'종로구 통인동 122'},
  {name:'엘도밍고',type:'멕시코·남미',area:'서울/마포·홍대·연남',addr:'마포구 망원동 485-28'},
  {name:'크리스피포크타운',type:'멕시코·남미',area:'서울/용산·이태원',addr:'용산구 이태원동 455-33'},
  {name:'달콩',type:'카페·디저트',area:'경기',addr:'성남시 분당구 정자동 137-5'},
  {name:'그로타 지간테 파스타',type:'양식·이탈리안',area:'서울/강남',addr:'강남구 일원동 682-7 지하1층'},
  {name:'타이키',type:'일식튀김·꼬치',area:'서울/강남',addr:'강남구 신사동 543-1'},
  {name:'야키토리 키유',type:'일식튀김·꼬치',area:'서울/마포·홍대·연남',addr:'마포구 도화동 200-14'},
  {name:'하루',type:'일식당',area:'경기',addr:'성남시 분당구 삼평동 680 h스퀘어 s동'},
  {name:'공원스크립트 가로수길점',type:'카페·디저트',area:'서울/강남',addr:'강남구 신사동 534-27'},
  {name:'셰프스위트',type:'양식',area:'경기',addr:'수원시 팔달구 남창동 78'},
  {name:'풍미 동서울대',type:'중식당',area:'경기',addr:'성남시 수정구 복정동 645-6'},
  {name:'눈내린빙수',type:'카페·디저트',area:'지방/기타',addr:'강원 춘천시 석사동 682-1'},
  {name:'저저',type:'한식',area:'서울/종로·을지로·중구',addr:'중구 인현동2가 182-2'},
  {name:'시오',type:'양식',area:'서울/강남',addr:'강남구 논현동 101-4'},
  {name:'멘야미코 청담역점',type:'일식·우동',area:'서울/강남',addr:'강남구 삼성동 65'},
  {name:'도우룸',type:'양식·이탈리안',area:'서울/강남',addr:'서초구 방배동 797-20 2층'},
  {name:'규카츠정 판교점',type:'일식·돈가스',area:'경기',addr:'성남시 분당구 삼평동 680'},
  {name:'도쿄젤라또',type:'카페·아이스크림',area:'경기',addr:'성남시 분당구 정자동 14-3'},
  {name:'수북동 by 윤경양식당',type:'양식·돈가스',area:'서울/성수·건대',addr:'성동구 성수동1가 668-105'},
  {name:'킹토스트 용산역점',type:'한식·토스트',area:'서울/용산·이태원',addr:'용산구 한강로3가 40-999'},
  {name:'오근내 닭갈비',type:'한식',area:'서울/용산·이태원',addr:'용산구 한강로3가 40-90'},
  {name:'꼰떼',type:'양식·이탈리안',area:'서울/종로·을지로·중구',addr:'종로구 부암동 269-8'},
  {name:'뤼도 발루즈',type:'카페·샌드위치',area:'서울/종로·을지로·중구',addr:'종로구 부암동 260-6'},
];

function makeNote(p, status) {
  const subArea = p.area.split('/').pop();
  return `---
name: "${p.name}"
type: "${p.type}"
area: "${p.area}"
address: "${p.addr}"
status: "${status}"
price: ""
rating: ""
memo: ""
---

# ${p.name}

> ${p.type} · ${subArea} · **${status}**

## 기본 정보
| 항목 | 내용 |
|---|---|
| 주소 | ${p.addr} |
| 분류 | ${p.type} |
| 지역 | ${subArea} |
| 가격대 | 검색 후 채울 예정 |
| 대표메뉴 | 검색 후 채울 예정 |
| 특징 | 검색 후 채울 예정 |
| 영업시간 | 검색 후 채울 예정 |

## 메모

`;
}

let created = 0;
for (const [list, status] of [[INSTA,'인스타찜'], [GOTO,'가볼곳']]) {
  for (const p of list) {
    const dir = path.join(VAULT, ...p.area.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    const fpath = path.join(dir, p.name + '.md');
    if (fs.existsSync(fpath)) { created++; continue; }
    fs.writeFileSync(fpath, makeNote(p, status), 'utf8');
    created++;
  }
}

// 전체 인덱스 갱신
function walkMd(dir, arr=[]) {
  for (const f of fs.readdirSync(dir)) {
    const p2 = path.join(dir, f);
    if (fs.statSync(p2).isDirectory()) walkMd(p2, arr);
    else if (f.endsWith('.md') && !f.startsWith('_')) arr.push(p2);
  }
  return arr;
}
const all = walkMd(VAULT);
const byStatus = {가봤음:[], 인스타찜:[], 가볼곳:[]};
for (const fp of all) {
  const c = fs.readFileSync(fp, 'utf8');
  const m = c.match(/^status: "(.+)"$/m);
  if (!m) continue;
  const s = m[1];
  if (byStatus[s]) byStatus[s].push(path.basename(fp, '.md'));
}
let master = `# 맛집 전체 인덱스\n\n> 가봤음 ${byStatus.가봤음.length}개 | 인스타찜 ${byStatus.인스타찜.length}개 | 가볼곳 ${byStatus.가볼곳.length}개\n\n`;
master += `## 🍽 가봤음 (${byStatus.가봤음.length})\n` + byStatus.가봤음.map(n=>`- [[${n}]]`).join('\n') + '\n\n';
master += `## 📸 인스타찜 (${byStatus.인스타찜.length})\n` + byStatus.인스타찜.map(n=>`- [[${n}]]`).join('\n') + '\n\n';
master += `## 🗓 가볼곳 (${byStatus.가볼곳.length})\n` + byStatus.가볼곳.map(n=>`- [[${n}]]`).join('\n') + '\n\n';
fs.writeFileSync(path.join(VAULT, '_전체 인덱스.md'), master, 'utf8');

console.log('완료:', created, '개 / 가봤음:', byStatus.가봤음.length, '/ 인스타찜:', byStatus.인스타찜.length, '/ 가볼곳:', byStatus.가볼곳.length);
