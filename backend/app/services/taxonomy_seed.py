"""Seed three taxonomy trees and heuristic folder→tag mapping.

统一编码：首位定分类标准，后面每一级都有编号。
  A — 原子/物理层（A → A1 → A1.1 → A1.1.1 …）
  B — 意图/功能层（B → B1 → B1.1 …）
  C — 风格化模式层（C → C1 → C1.1 → C1.1.1 …）
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import Folder, MotionClip, TaxonomyNode
from ..models.enums import TaxonomyScheme
from .permissions import join_folder_path, normalize_path
from .taxonomy_schemes import ensure_builtin_schemes

TAXONOMY_REVISION = "v7-atomic-or-combo"
REVISION_MARKER_PATH = "/原子or组合/原子/"


def _leaves(parent_code: str, *names: str) -> dict:
    """Leaf nodes coded as parent_code.1, parent_code.2, …"""
    return {n: (f"{parent_code}.{i}", None) for i, n in enumerate(names, start=1)}


# Nested dict: name -> (code, children_dict | None)
# Note: names must not contain "/".

# 图表方案：原子or组合 只分两类
ATOMIC_TREE = {
    "原子": ("A1", None),
    "组合": ("A2", None),
}

# 已弃用：v6 原子动作大树（保留备查，不再种子化）
_LEGACY_ATOMIC_TREE = {
    "位移类": (
        "A1",
        {
            "步态移动": ("A1.1", _leaves("A1.1", "走", "跑", "蹑手蹑脚", "后退", "侧滑步")),
            "跳跃移动": ("A1.2", _leaves("A1.2", "跳高", "跳远", "原地纵跳", "跨步跳")),
            "翻滚翻转移动": ("A1.3", _leaves("A1.3", "前滚翻", "后空翻", "旋子", "鱼跃前滚翻")),
            "攀爬匍匐移动": ("A1.4", _leaves("A1.4", "匍匐前进", "婴儿爬", "攀岩", "爬绳")),
            "滑动滑行移动": ("A1.5", _leaves("A1.5", "滑冰", "滑雪", "滑倒", "太空步")),
            "水中移动": ("A1.6", _leaves("A1.6", "游泳", "踩水", "潜水")),
            "被动失控移动": ("A1.7", _leaves("A1.7", "被推着走", "被拖行", "摔倒", "滚下山坡")),
        },
    ),
    "物品操作类": (
        "A2",
        {
            "持握固定": ("A2.1", _leaves("A2.1", "拿杯子", "握刀柄", "扶栏杆")),
            "释放投掷": ("A2.2", _leaves("A2.2", "扔球", "抛钥匙", "放下东西")),
            "接收接取": ("A2.3", _leaves("A2.3", "接球", "抓住抛物")),
            "推压": ("A2.4", _leaves("A2.4", "推门", "按开关", "揉面")),
            "拉拽": ("A2.5", _leaves("A2.5", "拉弓", "拽绳子", "拖行李箱")),
            "击打": ("A2.6", _leaves("A2.6", "拍球", "拳击沙袋", "踢足球", "敲键盘")),
            "旋转拧动": ("A2.7", _leaves("A2.7", "拧瓶盖", "转门把手", "用螺丝刀")),
            "支撑倚靠": ("A2.8", _leaves("A2.8", "手扶墙", "手撑桌面", "手倒立", "握扶手")),
        },
    ),
    "人际交互类": (
        "A3",
        {
            "接触式交互": (
                "A3.1",
                {
                    "亲昵友好接触": (
                        "A3.1.1",
                        _leaves("A3.1.1", "拥抱", "亲吻脸颊", "拍肩膀", "握手", "击掌", "挽手臂"),
                    ),
                    "攻击对抗接触": (
                        "A3.1.2",
                        _leaves("A3.1.2", "推搡", "打耳光", "拳打脚踢", "掐", "锁喉"),
                    ),
                    "礼节扶持接触": (
                        "A3.1.3",
                        _leaves("A3.1.3", "搀扶", "扶肩", "角力相持"),
                    ),
                },
            ),
            "非接触式交互": (
                "A3.2",
                {
                    "手势信号": (
                        "A3.2.1",
                        _leaves("A3.2.1", "挥手告别", "招手", "摆手拒绝", "竖大拇指", "指向某人"),
                    ),
                    "头部面部信号": (
                        "A3.2.2",
                        _leaves("A3.2.2", "点头", "摇头", "使眼色", "飞吻", "做鬼脸"),
                    ),
                    "身体姿态信号": (
                        "A3.2.3",
                        _leaves("A3.2.3", "鞠躬", "抱拳", "敬礼", "跪拜", "耸肩", "摊手"),
                    ),
                },
            ),
        },
    ),
    "自体类": (
        "A4",
        {
            "整体静态姿势": (
                "A4.1",
                _leaves("A4.1", "站立", "坐下", "蹲着", "跪着", "躺", "蜷缩", "金鸡独立"),
            ),
            "躯干肢体动作": (
                "A4.2",
                _leaves("A4.2", "伸懒腰", "转腰", "扭头", "抖腿", "下腰", "原地踢腿"),
            ),
            "自我接触": (
                "A4.3",
                _leaves("A4.3", "挠头", "托腮", "叉腰", "抱臂", "揉眼睛", "搓手"),
            ),
            "面部表情与眼球": (
                "A4.4",
                _leaves("A4.4", "笑", "哭", "皱眉", "眨眼", "翻白眼", "凝视", "扫视"),
            ),
            "呼吸生理动作": (
                "A4.5",
                _leaves("A4.5", "深呼吸", "打哈欠", "打喷嚏", "咳嗽", "打嗝", "叹气"),
            ),
        },
    ),
}

INTENT_TREE = {
    "个体维持": (
        "B1",
        {
            "身体调节": ("B1.1", None),
            "姿态切换": ("B1.2", None),
            "进食饮水": ("B1.3", None),
        },
    ),
    "物品操作": (
        "B2",
        {
            "改变物体位置": ("B2.1", None),
            "改变物体形态": ("B2.2", None),
            "工具使用": ("B2.3", None),
        },
    ),
    "空间移动": (
        "B3",
        {
            "单一移动": ("B3.1", None),
            "复合移动": ("B3.2", None),
        },
    ),
    "人际交互": (
        "B4",
        {
            "建立维持社交连接": ("B4.1", None),
            "传递信息": ("B4.2", None),
            "给予索取物品": ("B4.3", None),
            "对抗防御": ("B4.4", None),
        },
    ),
    "表达与创造": (
        "B5",
        {
            "情感表达": ("B5.1", None),
            "审美艺术创作": ("B5.2", None),
            "探索与感知": ("B5.3", None),
        },
    ),
}

STYLE_TREE = {
    "社会仪式": (
        "C1",
        {
            "礼节": ("C1.1", _leaves("C1.1", "握手礼", "鞠躬礼", "敬礼", "拥抱礼")),
            "典礼仪式": ("C1.2", _leaves("C1.2", "婚礼交换戒指", "升旗仪式", "宣誓")),
        },
    ),
    "竞技与运动": (
        "C2",
        {
            "田径水上": ("C2.1", _leaves("C2.1", "短跑", "跨栏", "跳高", "游泳", "跳水")),
            "球类器械对抗": (
                "C2.2",
                _leaves("C2.2", "足球", "篮球", "网球", "乒乓球", "羽毛球", "击剑"),
            ),
            "格斗搏击": ("C2.3", _leaves("C2.3", "拳击", "跆拳道", "柔道", "综合格斗")),
            "精准技巧类": ("C2.4", _leaves("C2.4", "射箭", "射击", "高尔夫", "保龄球")),
        },
    ),
    "表演与艺术": (
        "C3",
        {
            "舞蹈": ("C3.1", _leaves("C3.1", "芭蕾", "街舞", "拉丁舞", "民族舞")),
            "武术戏剧套路": (
                "C3.2",
                _leaves("C3.2", "螳螂拳", "太极拳", "京剧走边", "武打套招"),
            ),
            "杂技极限运动": (
                "C3.3",
                _leaves("C3.3", "跑酷", "后空翻", "走钢丝", "杂耍", "越障"),
            ),
            "音乐演奏指挥": ("C3.4", _leaves("C3.4", "弹钢琴", "拉小提琴", "指挥")),
        },
    ),
    # C4「生产与日常」：覆盖普通人日常生存、家庭运转与社会生产的常规行为。
    # 层级：C4 → C4.n 子类 → C4.n.m 细分项 → C4.n.m.k 典型动作（叶子）
    # 节点名不能含 "/"，原表中的「A/B」统一写作「A与B」。
    "生产与日常": (
        "C4",
        {
            "个人卫生与护理": (
                "C4.1",
                {
                    "洗漱": ("C4.1.1", _leaves("C4.1.1", "刷牙", "洗脸", "洗手", "漱口")),
                    "沐浴与如厕": (
                        "C4.1.2",
                        _leaves("C4.1.2", "淋浴", "泡澡", "洗头", "上厕所"),
                    ),
                    "整容修饰": (
                        "C4.1.3",
                        _leaves(
                            "C4.1.3",
                            "梳头",
                            "化妆",
                            "刮胡子",
                            "涂护肤品",
                            "剪指甲",
                        ),
                    ),
                    "穿衣与脱衣": (
                        "C4.1.4",
                        _leaves(
                            "C4.1.4",
                            "穿衣服",
                            "脱衣服",
                            "换衣服",
                            "系鞋带",
                            "戴领带",
                        ),
                    ),
                },
            ),
            "饮食准备与用餐": (
                "C4.2",
                {
                    "食材处理": (
                        "C4.2.1",
                        _leaves("C4.2.1", "洗菜", "切菜", "择菜", "和面", "腌制"),
                    ),
                    "烹饪与加热": (
                        "C4.2.2",
                        _leaves("C4.2.2", "炒菜", "煮面", "蒸饭", "热牛奶", "煎蛋"),
                    ),
                    "布置与收拾餐桌": (
                        "C4.2.3",
                        _leaves("C4.2.3", "摆碗筷", "盛饭", "倒饮料", "收盘子"),
                    ),
                    "用餐与饮水": (
                        "C4.2.4",
                        _leaves("C4.2.4", "用筷子吃饭", "用叉吃面", "喝汤", "喝水"),
                    ),
                    "洗碗与清洁厨房": (
                        "C4.2.5",
                        _leaves("C4.2.5", "刷碗", "擦灶台", "倒垃圾"),
                    ),
                },
            ),
            "家务与居家维护": (
                "C4.3",
                {
                    "打扫与除尘": (
                        "C4.3.1",
                        _leaves("C4.3.1", "扫地", "拖地", "擦桌子", "掸灰尘"),
                    ),
                    "洗衣晾晒与收纳": (
                        "C4.3.2",
                        _leaves(
                            "C4.3.2",
                            "把衣服放进洗衣机",
                            "晾衣服",
                            "收衣服",
                            "叠衣服",
                        ),
                    ),
                    "整理与收纳": (
                        "C4.3.3",
                        _leaves("C4.3.3", "叠被子", "整理桌面", "收纳杂物", "铺床单"),
                    ),
                    "居家维修与组装": (
                        "C4.3.4",
                        _leaves(
                            "C4.3.4",
                            "换灯泡",
                            "拼装家具",
                            "通下水道",
                            "钉钉子",
                        ),
                    ),
                    "照护人宠与植物": (
                        "C4.3.5",
                        _leaves(
                            "C4.3.5",
                            "给花浇水",
                            "给猫喂食",
                            "帮老人量血压",
                            "给小孩穿衣服",
                        ),
                    ),
                },
            ),
            "出行与交通": (
                "C4.4",
                {
                    "步行通勤": (
                        "C4.4.1",
                        _leaves("C4.4.1", "走路去地铁站", "步行去超市", "散步"),
                    ),
                    "骑行与驾驶": (
                        "C4.4.2",
                        _leaves("C4.4.2", "骑自行车", "骑电动车", "开车"),
                    ),
                    "乘坐公共交通": (
                        "C4.4.3",
                        _leaves("C4.4.3", "坐公交", "乘地铁", "打出租车", "坐火车"),
                    ),
                    "携带与搬运重物": (
                        "C4.4.4",
                        _leaves("C4.4.4", "拎购物袋回家", "搬快递箱上楼"),
                    ),
                },
            ),
            "购物与消费": (
                "C4.5",
                {
                    "挑选与查看商品": (
                        "C4.5.1",
                        _leaves(
                            "C4.5.1",
                            "在超市拿菜",
                            "在服装店翻看衣服",
                            "看食品保质期",
                        ),
                    ),
                    "支付与结账": (
                        "C4.5.2",
                        _leaves("C4.5.2", "扫码支付", "递现金", "刷卡"),
                    ),
                    "取货与拆包": (
                        "C4.5.3",
                        _leaves("C4.5.3", "取快递", "拆快递盒", "检查商品"),
                    ),
                },
            ),
            "学习与信息处理": (
                "C4.6",
                {
                    "阅读与观看": (
                        "C4.6.1",
                        _leaves(
                            "C4.6.1",
                            "看书",
                            "看手机屏幕",
                            "看电脑或电视",
                            "读报",
                        ),
                    ),
                    "书写与记录": (
                        "C4.6.2",
                        _leaves("C4.6.2", "用笔写字", "做笔记", "在手机上打字聊天"),
                    ),
                    "操作数字设备": (
                        "C4.6.3",
                        _leaves(
                            "C4.6.3",
                            "用鼠标",
                            "敲键盘",
                            "滑动手机屏幕",
                            "点触平板",
                        ),
                    ),
                },
            ),
            "工作与生产劳动": (
                "C4.7",
                {
                    "办公与文书": (
                        "C4.7.1",
                        _leaves("C4.7.1", "打印文件", "整理档案", "开会", "接打电话"),
                    ),
                    "手工与体力劳动": (
                        "C4.7.2",
                        _leaves(
                            "C4.7.2",
                            "搬货",
                            "砌砖",
                            "焊接",
                            "农田耕作",
                            "流水线操作",
                        ),
                    ),
                    "服务与照护职业": (
                        "C4.7.3",
                        _leaves(
                            "C4.7.3",
                            "理发师剪发",
                            "服务员上菜",
                            "护士打针",
                            "按摩师推拿",
                        ),
                    ),
                    "创造性生产": (
                        "C4.7.4",
                        _leaves(
                            "C4.7.4",
                            "画画",
                            "做手工",
                            "弹琴自娱或创作",
                            "写代码",
                        ),
                    ),
                },
            ),
            "休闲与娱乐": (
                "C4.8",
                {
                    "静态休闲": (
                        "C4.8.1",
                        _leaves(
                            "C4.8.1",
                            "靠在沙发上看电视",
                            "躺着听音乐",
                            "发呆",
                        ),
                    ),
                    "动态休闲": (
                        "C4.8.2",
                        _leaves("C4.8.2", "遛狗", "逛公园", "跳广场舞", "玩飞盘"),
                    ),
                    "游戏与玩耍": (
                        "C4.8.3",
                        _leaves(
                            "C4.8.3",
                            "玩手机游戏",
                            "玩桌游",
                            "逗小孩玩",
                            "拼乐高",
                        ),
                    ),
                },
            ),
            "休息与睡眠": (
                "C4.9",
                {
                    "打盹与小睡": (
                        "C4.9.1",
                        _leaves("C4.9.1", "趴在桌上眯一会儿", "在沙发上午睡"),
                    ),
                    "就寝与睡眠": (
                        "C4.9.2",
                        _leaves("C4.9.2", "躺在床上盖被子", "关灯睡觉"),
                    ),
                    "休息与放松": (
                        "C4.9.3",
                        _leaves("C4.9.3", "坐着闭目养神", "躺下伸个懒腰", "泡脚"),
                    ),
                },
            ),
        },
    ),
}

ROOTS = {
    TaxonomyScheme.atomic.value: ("原子or组合", ATOMIC_TREE),
    TaxonomyScheme.intent.value: ("意图", INTENT_TREE),
    TaxonomyScheme.style.value: ("风格", STYLE_TREE),
}

# 首位：分类标准
ROOT_CODES = {
    TaxonomyScheme.atomic.value: "A",
    TaxonomyScheme.intent.value: "B",
    TaxonomyScheme.style.value: "C",
}

_ATOMIC_FOLDER_ALIAS = {
    "移动": "位移类",
    "位移": "位移类",
    "位移类": "位移类",
    "物品操作": "物品操作类",
    "物品操作类": "物品操作类",
    "人际交互": "人际交互类",
    "人际交互类": "人际交互类",
    "自身姿态与表达": "自体类",
    "自体": "自体类",
    "自体类": "自体类",
}

_ATOMIC_SUB_ALIAS = {
    "步态": "步态移动",
    "步态移动": "步态移动",
    "跳跃": "跳跃移动",
    "跳跃移动": "跳跃移动",
    "翻滚": "翻滚翻转移动",
    "翻滚翻转": "翻滚翻转移动",
    "翻滚翻转移动": "翻滚翻转移动",
    "匍匐": "攀爬匍匐移动",
    "攀爬": "攀爬匍匐移动",
    "攀爬匍匐移动": "攀爬匍匐移动",
    "走": ("位移类", "步态移动", "走"),
    "跑": ("位移类", "步态移动", "跑"),
    "持握": "持握固定",
    "释放": "释放投掷",
    "旋转": "旋转拧动",
    "姿势": "整体静态姿势",
    "表情": "面部表情与眼球",
    "眼球": "面部表情与眼球",
    "肢体": "躯干肢体动作",
}


def _ensure_node(
    db: Session,
    scheme: str,
    parent: TaxonomyNode | None,
    name: str,
    code: str,
    sort_order: int,
) -> TaxonomyNode:
    parent_path = parent.path if parent else None
    path = join_folder_path(parent_path, name) if parent else normalize_path(f"/{name}/")
    existing = (
        db.query(TaxonomyNode)
        .filter(TaxonomyNode.scheme == scheme, TaxonomyNode.path == path)
        .first()
    )
    want_code = code or ""
    if existing:
        if existing.code != want_code:
            existing.code = want_code
        if existing.sort_order != sort_order:
            existing.sort_order = sort_order
        if path == REVISION_MARKER_PATH and existing.description != TAXONOMY_REVISION:
            existing.description = TAXONOMY_REVISION
        return existing
    node = TaxonomyNode(
        scheme=scheme,
        parent_id=parent.id if parent else None,
        code=want_code,
        name=name,
        path=path,
        sort_order=sort_order,
        description=TAXONOMY_REVISION if path == REVISION_MARKER_PATH else "",
    )
    db.add(node)
    db.flush()
    return node


def _seed_tree(
    db: Session,
    scheme: str,
    parent: TaxonomyNode | None,
    tree: dict,
) -> None:
    for idx, (name, payload) in enumerate(tree.items()):
        code, children = payload
        node = _ensure_node(db, scheme, parent, name, code or "", idx)
        if children:
            _seed_tree(db, scheme, node, children)


def seed_taxonomies(db: Session) -> None:
    ensure_builtin_schemes(db)
    for scheme, (root_name, tree) in ROOTS.items():
        root = _ensure_node(db, scheme, None, root_name, ROOT_CODES.get(scheme, ""), 0)
        _seed_tree(db, scheme, root, tree)
    db.flush()


def needs_taxonomy_rebuild(db: Session) -> bool:
    marker = (
        db.query(TaxonomyNode)
        .filter(
            TaxonomyNode.scheme == TaxonomyScheme.atomic.value,
            TaxonomyNode.path == REVISION_MARKER_PATH,
        )
        .first()
    )
    if marker is None:
        return True
    return (marker.description or "") != TAXONOMY_REVISION


def rebuild_taxonomies(db: Session) -> None:
    """Rebuild built-in trees only; custom scheme nodes are preserved."""
    from ..models import ClipTaxonomyTag

    builtin = list(ROOTS.keys())
    db.query(MotionClip).update(
        {
            MotionClip.atomic_tag_id: None,
            MotionClip.intent_tag_id: None,
            MotionClip.style_tag_id: None,
        },
        synchronize_session=False,
    )
    db.flush()
    db.query(ClipTaxonomyTag).filter(ClipTaxonomyTag.scheme.in_(builtin)).delete(
        synchronize_session=False
    )
    nodes = (
        db.query(TaxonomyNode)
        .filter(TaxonomyNode.scheme.in_(builtin))
        .order_by(TaxonomyNode.path.desc())
        .all()
    )
    for n in nodes:
        db.delete(n)
    db.flush()
    seed_taxonomies(db)


def _collect_seed_paths(
    parent_path: str,
    tree: dict,
    out: set[str],
) -> None:
    """Collect normalize paths for every node defined under parent_path in seed tree."""
    for name, payload in tree.items():
        _code, children = payload
        path = join_folder_path(parent_path, name)
        out.add(path)
        if children:
            _collect_seed_paths(path, children, out)


def prune_style_production_daily(db: Session) -> None:
    """Remove obsolete C4 children not in the current seed; remap clip style tags to C4 root."""
    root = (
        db.query(TaxonomyNode)
        .filter(
            TaxonomyNode.scheme == TaxonomyScheme.style.value,
            TaxonomyNode.path == "/风格/生产与日常/",
        )
        .first()
    )
    if not root:
        return
    expected: set[str] = {root.path}
    children_tree = STYLE_TREE["生产与日常"][1]
    _collect_seed_paths(root.path, children_tree, expected)

    stale = (
        db.query(TaxonomyNode)
        .filter(
            TaxonomyNode.scheme == TaxonomyScheme.style.value,
            TaxonomyNode.path.like("/风格/生产与日常/%"),
            TaxonomyNode.path != root.path,
        )
        .order_by(TaxonomyNode.path.desc())
        .all()
    )
    for node in stale:
        if node.path in expected:
            continue
        db.query(MotionClip).filter(MotionClip.style_tag_id == node.id).update(
            {MotionClip.style_tag_id: root.id},
            synchronize_session=False,
        )
        db.delete(node)
    db.flush()


def ensure_taxonomies(db: Session) -> None:
    if needs_taxonomy_rebuild(db):
        # Soft upgrade: keep existing clip tags when possible; only full-rebuild
        # if taxonomy tables are empty or the revision marker node is missing.
        marker = (
            db.query(TaxonomyNode)
            .filter(
                TaxonomyNode.scheme == TaxonomyScheme.atomic.value,
                TaxonomyNode.path == REVISION_MARKER_PATH,
            )
            .first()
        )
        if marker is None and db.query(TaxonomyNode).first():
            rebuild_taxonomies(db)
        else:
            seed_taxonomies(db)
            prune_style_production_daily(db)
    else:
        seed_taxonomies(db)
        prune_style_production_daily(db)


def _find_by_name_path(db: Session, scheme: str, *names: str) -> TaxonomyNode | None:
    root_name = ROOTS[scheme][0]
    path = normalize_path("/".join([root_name, *names]))
    return (
        db.query(TaxonomyNode)
        .filter(TaxonomyNode.scheme == scheme, TaxonomyNode.path == path)
        .first()
    )


def _map_atomic_parts(parts: list[str]) -> list[str]:
    if not parts:
        return []
    mapped: list[str] = []
    top = _ATOMIC_FOLDER_ALIAS.get(parts[0], parts[0])
    mapped.append(top)
    for part in parts[1:]:
        alias = _ATOMIC_SUB_ALIAS.get(part, part)
        if isinstance(alias, tuple):
            return list(alias)
        mapped.append(alias)
    return mapped


def map_folder_path_to_tags(folder_path: str, db: Session) -> dict[str, int | None]:
    p = normalize_path(folder_path)
    atomic_id = intent_id = style_id = None

    if p.startswith("/基础动作/"):
        rest = p[len("/基础动作/") :].strip("/")
        parts = [x for x in rest.split("/") if x]
        mapped = _map_atomic_parts(parts)
        node = None
        for depth in range(len(mapped), 0, -1):
            node = _find_by_name_path(db, TaxonomyScheme.atomic.value, *mapped[:depth])
            if node:
                break
        if not node and mapped:
            node = _find_by_name_path(db, TaxonomyScheme.atomic.value, mapped[0])
        atomic_id = node.id if node else None

    if p.startswith("/组合动作/"):
        rest = p[len("/组合动作/") :].strip("/")
        parts = [x for x in rest.split("/") if x]
        style_parts: list[str] = []
        if parts:
            top = parts[0]
            if top == "体育":
                style_parts = ["竞技与运动"]
                if len(parts) >= 2:
                    sub = parts[1]
                    if sub == "球类":
                        style_parts += ["球类器械对抗"] + parts[2:]
                    elif sub in ("奔跑", "行走", "短跑"):
                        style_parts += ["田径水上", "短跑"]
                    elif sub == "跳跃":
                        style_parts += ["田径水上", "跳高"]
                    elif sub == "游泳":
                        style_parts += ["田径水上", "游泳"]
                    elif sub == "匍匐":
                        style_parts += ["田径水上"]
                    else:
                        style_parts += parts[1:]
            elif top == "舞蹈":
                style_parts = ["表演与艺术", "舞蹈"] + parts[1:]
            elif top == "武术":
                style_parts = ["表演与艺术", "武术戏剧套路"] + parts[1:]
            elif top == "越障":
                style_parts = ["表演与艺术", "杂技极限运动", "越障"]
            else:
                style_parts = parts
        node = None
        for depth in range(len(style_parts), 0, -1):
            node = _find_by_name_path(
                db, TaxonomyScheme.style.value, *style_parts[:depth]
            )
            if node:
                break
        style_id = node.id if node else None

    return {"atomic_tag_id": atomic_id, "intent_tag_id": intent_id, "style_tag_id": style_id}


def apply_folder_heuristic_to_clips(db: Session) -> None:
    from .taxonomy_schemes import set_clip_taxonomy_tag

    folders = {f.id: f for f in db.query(Folder).all()}
    clips = db.query(MotionClip).all()
    for clip in clips:
        if clip.atomic_tag_id and clip.intent_tag_id and clip.style_tag_id:
            continue
        folder = folders.get(clip.folder_id) if clip.folder_id else None
        if not folder:
            continue
        mapped = map_folder_path_to_tags(folder.path, db)
        if not clip.atomic_tag_id and mapped["atomic_tag_id"]:
            set_clip_taxonomy_tag(
                db, clip, TaxonomyScheme.atomic.value, mapped["atomic_tag_id"]
            )
        if not clip.intent_tag_id and mapped["intent_tag_id"]:
            set_clip_taxonomy_tag(
                db, clip, TaxonomyScheme.intent.value, mapped["intent_tag_id"]
            )
        if not clip.style_tag_id and mapped["style_tag_id"]:
            set_clip_taxonomy_tag(
                db, clip, TaxonomyScheme.style.value, mapped["style_tag_id"]
            )
    db.flush()
