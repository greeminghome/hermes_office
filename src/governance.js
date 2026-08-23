import { TEAM_META } from "./officeData.js";

export const WORKSPACE_AREAS = [
  {
    id: "01_브랜드",
    label: "브랜드",
    owners: ["hermes-brand"],
    folders: ["01_브랜드"],
    keywords: ["브랜드", "정체성", "브랜드 아키텍처", "브랜드 문서"],
  },
  {
    id: "02_상품_가격",
    label: "상품/가격",
    owners: ["hermes-operations", "hermes-finance"],
    folders: ["02_상품_가격"],
    keywords: ["상품", "가격", "가격표", "패키지", "예약 옵션"],
  },
  {
    id: "03_마케팅_채널",
    label: "마케팅/채널",
    owners: ["hermes-growth", "hermes-content"],
    folders: ["03_마케팅_채널"],
    keywords: ["마케팅", "채널", "인스타그램", "블로그", "플레이스", "카카오", "콘텐츠", "SNS"],
  },
  {
    id: "04_운영",
    label: "운영",
    owners: ["hermes-operations"],
    folders: ["04_운영"],
    keywords: ["운영", "SOP", "체크리스트", "핸드오버", "업무", "예약"],
  },
  {
    id: "05_고객_후기",
    label: "고객/후기",
    owners: ["hermes-customer"],
    folders: ["05_고객_후기"],
    keywords: ["고객", "후기", "리뷰", "VOC", "상담", "인입"],
  },
  {
    id: "06_재무_매출",
    label: "재무/매출",
    owners: ["hermes-finance"],
    folders: ["06_재무_매출"],
    keywords: ["재무", "매출", "KPI", "정산", "비용", "예산", "세금"],
  },
  {
    id: "07_법무_계약",
    label: "법무/계약",
    owners: ["default"],
    folders: ["07_법무_계약"],
    keywords: ["법무", "계약", "약관", "개인정보", "소송", "신고", "사업자"],
    critical: true,
  },
  {
    id: "08_공간_자산",
    label: "공간/자산",
    owners: ["hermes-operations", "hermes-creative"],
    folders: ["08_공간_자산"],
    keywords: ["공간", "자산", "평면도", "촬영", "자연광", "사진"],
  },
  {
    id: "09_경영_전략",
    label: "경영/전략",
    owners: ["default"],
    folders: ["09_경영_전략"],
    keywords: ["경영", "전략", "거버넌스", "우선순위", "의사결정", "KPI"],
    critical: true,
  },
];

const WRITE_INTENT_PATTERN = /수정|변경|삭제|추가|생성|작성|업데이트|반영|고쳐|바꿔|만들|저장|정리해줘|올려|넣어|edit|update|delete|create|write|save/i;
const CRITICAL_PATTERN = /법무|계약|약관|개인정보|매출|정산|예산|가격\s*확정|결제|배포|외부\s*공개|연동|판매|리스크|critical|risk/i;

export function profileLabel(profileName) {
  return TEAM_META[profileName]?.name ?? profileName;
}

export function areaOwnerLabels(area) {
  return area.owners.map(profileLabel).join(", ");
}

export function findWorkspaceArea(text = "") {
  const normalized = String(text);
  const folderMatch = WORKSPACE_AREAS.find((area) => area.folders.some((folder) => normalized.includes(folder)));
  if (folderMatch) return folderMatch;
  return WORKSPACE_AREAS.find((area) =>
    area.keywords.some((keyword) => normalized.toLowerCase().includes(keyword.toLowerCase())),
  ) ?? null;
}

export function hasWriteIntent(text = "") {
  return WRITE_INTENT_PATTERN.test(String(text));
}

export function isCriticalChange(text = "", area = null) {
  return Boolean(area?.critical) || CRITICAL_PATTERN.test(String(text));
}

export function canWriteWorkspaceArea(profileName, area) {
  if (!area) return true;
  if (profileName === "default") return true;
  return area.owners.includes(profileName);
}

export function evaluateWorkspaceChange(profileName, text = "") {
  const area = findWorkspaceArea(text);
  const writeIntent = hasWriteIntent(text);
  if (!area || !writeIntent) return { area, writeIntent, allowed: true, requiresApproval: false, escalate: false };
  const allowed = canWriteWorkspaceArea(profileName, area);
  const escalate = isCriticalChange(text, area);
  return {
    area,
    writeIntent,
    allowed,
    requiresApproval: !allowed,
    escalate,
    approvers: escalate ? ["default"] : area.owners,
  };
}

export function workspaceGovernancePrompt(profileName) {
  const writable = WORKSPACE_AREAS
    .filter((area) => canWriteWorkspaceArea(profileName, area))
    .map((area) => `${area.id}(${area.label})`)
    .join(", ");
  const areaLines = WORKSPACE_AREAS
    .map((area) => `- ${area.id}: 쓰기 담당 ${areaOwnerLabels(area)}${area.critical ? " / 중요 변경은 대표 검토" : ""}`)
    .join("\n");
  return [
    "[workspace 영역 권한 규칙]",
    `현재 구성원: ${profileLabel(profileName)}(${profileName})`,
    `직접 추가/수정/삭제 가능한 영역: ${writable || "없음"}`,
    areaLines,
    "해당 영역 밖의 01~09 폴더 쓰기는 검토만 허용합니다.",
    "해당 영역 밖에 수정이 필요하면 직접 쓰지 말고 명분과 변경 범위를 적어 담당자에게 수정 요청하세요.",
    "담당자는 동의/미동의할 수 있으며, 미동의 사유가 명확해야 합니다.",
    "법무, 계약, 개인정보, 경영전략, 가격 확정, 결제, 배포처럼 중요하거나 외부에 영향을 주는 변경은 대표에게 상위 검토 요청으로 올리세요.",
  ].join("\n");
}

export function buildAreaApprovalRequest({ requester, text, decision }) {
  const targetArea = decision.area;
  const approvers = decision.approvers ?? targetArea?.owners ?? ["default"];
  const mainApprover = approvers[0] ?? "default";
  return {
    id: `area-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "area-change",
    title: `${targetArea?.id ?? "workspace"} 수정 요청`,
    description: `${profileLabel(requester)}가 ${targetArea?.label ?? "공용 영역"}에 대한 변경 권한을 요청했습니다. 명분: ${String(text).slice(0, 160)}`,
    requester,
    approver: mainApprover,
    approvers,
    room: targetArea?.id ?? "workspace",
    risk: decision.escalate ? "상위 검토" : "담당자 승인",
    areaId: targetArea?.id,
    areaLabel: targetArea?.label,
    reason: String(text).slice(0, 500),
    status: "pending",
    escalated: decision.escalate,
  };
}
