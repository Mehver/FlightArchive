# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

"""Default seed catalogs for a fresh workspace.

 Ported from the original default Dexie seed data so a new
workspace starts with a usable airline/airport/aircraft-type catalog.
This data lives only in memory; it is written to disk solely as part of
 the initial local business-data file.
"""

from __future__ import annotations

from typing import Any

_SUPPLEMENTAL_AIRLINES: list[dict[str, Any]] = [
    # 中国航司
    {"code": "CA", "icao": "CCA", "nameZh": "中国国航", "nameEn": "Air China", "alliance": "星空联盟"},
    {"code": "MU", "icao": "CES", "nameZh": "东方航空", "nameEn": "China Eastern", "alliance": "天合联盟"},
    {"code": "CZ", "icao": "CSN", "nameZh": "南方航空", "nameEn": "China Southern", "alliance": None},
    {"code": "HU", "icao": "CHH", "nameZh": "海南航空", "nameEn": "Hainan Airlines", "alliance": None},
    {"code": "3U", "icao": "CSC", "nameZh": "四川航空", "nameEn": "Sichuan Airlines", "alliance": None},
    {"code": "ZH", "icao": "CSZ", "nameZh": "深圳航空", "nameEn": "Shenzhen Airlines", "alliance": "星空联盟"},
    {"code": "MF", "icao": "CXA", "nameZh": "厦门航空", "nameEn": "XiamenAir", "alliance": "天合联盟"},
    {"code": "FM", "icao": "CSH", "nameZh": "上海航空", "nameEn": "Shanghai Airlines", "alliance": None},
    {"code": "GS", "icao": "GCR", "nameZh": "天津航空", "nameEn": "Tianjin Airlines", "alliance": None},
    {"code": "SC", "icao": "CDG", "nameZh": "山东航空", "nameEn": "Shandong Airlines", "alliance": None},
    {"code": "HO", "icao": "DKH", "nameZh": "吉祥航空", "nameEn": "Juneyao Air", "alliance": None},
    {"code": "9C", "icao": "CQH", "nameZh": "春秋航空", "nameEn": "Spring Airlines", "alliance": None},
    # 欧洲主要航司
    {"code": "LH", "icao": "DLH", "nameZh": "汉莎航空", "nameEn": "Lufthansa", "alliance": "星空联盟"},
    {"code": "AF", "icao": "AFR", "nameZh": "法国航空", "nameEn": "Air France", "alliance": "天合联盟"},
    {"code": "KL", "icao": "KLM", "nameZh": "荷兰皇家", "nameEn": "KLM", "alliance": "天合联盟"},
    {"code": "BA", "icao": "BAW", "nameZh": "英国航空", "nameEn": "British Airways", "alliance": "寰宇一家"},
    {"code": "LX", "icao": "SWR", "nameZh": "瑞士航空", "nameEn": "SWISS", "alliance": "星空联盟"},
    {"code": "OS", "icao": "AUA", "nameZh": "奥地利航空", "nameEn": "Austrian Airlines", "alliance": "星空联盟"},
    {"code": "TK", "icao": "THY", "nameZh": "土耳其航空", "nameEn": "Turkish Airlines", "alliance": "星空联盟"},
    {"code": "AY", "icao": "FIN", "nameZh": "芬兰航空", "nameEn": "Finnair", "alliance": "寰宇一家"},
    {"code": "IB", "icao": "IBE", "nameZh": "伊比利亚航空", "nameEn": "Iberia", "alliance": "寰宇一家"},
    {"code": "SK", "icao": "SAS", "nameZh": "北欧航空", "nameEn": "SAS", "alliance": "天合联盟"},
    {"code": "TP", "icao": "TAP", "nameZh": "葡萄牙航空", "nameEn": "TAP Air Portugal", "alliance": "星空联盟"},
    {"code": "LO", "icao": "LOT", "nameZh": "波兰航空", "nameEn": "LOT Polish Airlines", "alliance": "星空联盟"},
    {"code": "AZ", "icao": "ITY", "nameZh": "意大利航空", "nameEn": "ITA Airways", "alliance": "天合联盟"},
    {"code": "SN", "icao": "BEL", "nameZh": "布鲁塞尔航空", "nameEn": "Brussels Airlines", "alliance": "星空联盟"},
    {"code": "EI", "icao": "EIN", "nameZh": "爱尔兰航空", "nameEn": "Aer Lingus", "alliance": None},
    {"code": "A3", "icao": "AEE", "nameZh": "爱琴海航空", "nameEn": "Aegean Airlines", "alliance": "星空联盟"},
    {"code": "VY", "icao": "VLG", "nameZh": "伏林航空", "nameEn": "Vueling", "alliance": None},
    {"code": "U2", "icao": "EZY", "nameZh": "易捷航空", "nameEn": "easyJet", "alliance": None},
    # 美国主要航司
    {"code": "AA", "icao": "AAL", "nameZh": "美国航空", "nameEn": "American Airlines", "alliance": "寰宇一家"},
    {"code": "DL", "icao": "DAL", "nameZh": "达美航空", "nameEn": "Delta Air Lines", "alliance": "天合联盟"},
    {"code": "UA", "icao": "UAL", "nameZh": "美联航", "nameEn": "United Airlines", "alliance": "星空联盟"},
    {"code": "AS", "icao": "ASA", "nameZh": "阿拉斯加航空", "nameEn": "Alaska Airlines", "alliance": "寰宇一家"},
    {"code": "B6", "icao": "JBU", "nameZh": "捷蓝航空", "nameEn": "JetBlue", "alliance": None},
    {"code": "WN", "icao": "SWA", "nameZh": "西南航空", "nameEn": "Southwest Airlines", "alliance": None},
    {"code": "AC", "icao": "ACA", "nameZh": "加拿大航空", "nameEn": "Air Canada", "alliance": "星空联盟"},
    # 亚洲/中东主要航司
    {"code": "NH", "icao": "ANA", "nameZh": "全日空", "nameEn": "ANA", "alliance": "星空联盟"},
    {"code": "JL", "icao": "JAL", "nameZh": "日本航空", "nameEn": "Japan Airlines", "alliance": "寰宇一家"},
    {"code": "KE", "icao": "KAL", "nameZh": "大韩航空", "nameEn": "Korean Air", "alliance": "天合联盟"},
    {"code": "OZ", "icao": "AAR", "nameZh": "韩亚航空", "nameEn": "Asiana Airlines", "alliance": "星空联盟"},
    {"code": "CX", "icao": "CPA", "nameZh": "国泰航空", "nameEn": "Cathay Pacific", "alliance": "寰宇一家"},
    {"code": "SQ", "icao": "SIA", "nameZh": "新加坡航空", "nameEn": "Singapore Airlines", "alliance": "星空联盟"},
    {"code": "EK", "icao": "UAE", "nameZh": "阿联酋航空", "nameEn": "Emirates", "alliance": None},
    {"code": "QR", "icao": "QTR", "nameZh": "卡塔尔航空", "nameEn": "Qatar Airways", "alliance": "寰宇一家"},
    {"code": "EY", "icao": "ETD", "nameZh": "阿提哈德航空", "nameEn": "Etihad Airways", "alliance": None},
    {"code": "TG", "icao": "THA", "nameZh": "泰国航空", "nameEn": "Thai Airways", "alliance": "星空联盟"},
]


def _legacy_airline(
    code: str,
    icao: str,
    name_zh: str,
    name_en: str,
    alliance: str | None,
    primary_brand_color: str,
    contrast_brand_color: str,
) -> dict[str, Any]:
    """Convert the selected v1 airline fields to the current catalog shape."""
    return {
        "code": code,
        "icao": icao,
        "nameZh": name_zh,
        "nameEn": name_en,
        "alliance": alliance,
        "horizontalLogoResourcePath": None,
        "horizontalDarkLogoResourcePath": None,
        "symbolLogoResourcePath": None,
        "brandColors": {"primary": primary_brand_color, "contrast": contrast_brand_color},
    }


# Curated from the legacy workspace's airline catalog only; all non-airline
# workspace data is intentionally absent.
_LEGACY_AIRLINES = [
    _legacy_airline("AC", "ACA", "加拿大航空", "Air Canada", "星空联盟", "#F4142C", "#2E2A25"),
    _legacy_airline("AF", "AFR", "法国航空", "Air France", "天合联盟", "#AB0414", "#FFFFFF"),
    _legacy_airline("CA", "CCA", "中国国航", "Air China", "星空联盟", "#DC1C2C", "#DC1C2C"),
    _legacy_airline("CI", "CAL", "中华航空", "China Airlines", "天合联盟", "#E59EA9", "#A42C3C"),
    _legacy_airline("CX", "CPA", "国泰航空", "Cathay Pacific", "寰宇一家", "#045C64", "#045C64"),
    _legacy_airline("CZ", "CSN", "南方航空", "China Southern", None, "#0494D4", "#FFFFFF"),
    _legacy_airline("DL", "DAL", "达美航空", "Delta Air Lines", "天合联盟", "#9C1C34", "#04245C"),
    _legacy_airline("EY", "ETD", "阿提哈德航空", "Etihad Airways", None, "#D3831C", "#C9C8BA"),
    _legacy_airline("GK", "JJP", "捷星日本航空", "Jetstar Japan", "", "#FC5414", "#FFFFFF"),
    _legacy_airline("HU", "CHH", "海南航空", "Hainan Airlines", None, "#E40414", "#FFE105"),
    _legacy_airline("HX", "CRK", "香港航空", "Hong Kong Airlines", "", "#E40414", "#7A076C"),
    _legacy_airline("KE", "KAL", "大韩航空", "Korean Air", "天合联盟", "#0078D4", "#041464"),
    _legacy_airline("KG", "LYM", "青柠航空", "Key Lime / DAC", None, "#00BE49", "#001146"),
    _legacy_airline("KL", "KLM", "荷兰皇家", "KLM", "天合联盟", "#049CDC", "#FFFFFF"),
    _legacy_airline("KN", "CUA", "中国联合航空", "China United Airlines", "", "#D4046C", "#FFFFFF"),
    _legacy_airline("LH", "DLH", "汉莎航空", "Lufthansa", "星空联盟", "#04245C", "#FFFFFF"),
    _legacy_airline("MU", "CES", "东方航空", "China Eastern", "天合联盟", "#D70819", "#0B3393"),
    _legacy_airline("PR", "PAL", "菲律宾航空", "Philippine Airlines", "", "#041C63", "#EC2C2C"),
    _legacy_airline("SQ", "SIA", "新加坡航空", "Singapore Airlines", "星空联盟", "#FCA404", "#00266B"),
    _legacy_airline("UA", "UAL", "美联航", "United Airlines", "星空联盟", "#1414D4", "#FFFFFF"),
    _legacy_airline("UO", "HKE", "香港快运航空", "HK Express", "", "#742C94", "#24BCDC"),
    _legacy_airline("YP", "APZ", "普莱米娅航空", "Air Premia", "", "#EC542C", "#262C50"),
    _legacy_airline("ZH", "CSZ", "深圳航空", "Shenzhen Airlines", "星空联盟", "#D40C24", "#E7CA7C"),
]

_legacy_airlines_by_code = {airline["code"]: airline for airline in _LEGACY_AIRLINES}
_supplemental_airline_codes = {airline["code"] for airline in _SUPPLEMENTAL_AIRLINES}
DEFAULT_AIRLINES: list[dict[str, Any]] = [
    {**airline, **_legacy_airlines_by_code.get(airline["code"], {})}
    for airline in _SUPPLEMENTAL_AIRLINES
]
DEFAULT_AIRLINES.extend(
    airline for airline in _LEGACY_AIRLINES if airline["code"] not in _supplemental_airline_codes
)

_AIRLINE_THEME_COLORS: dict[str, tuple[str, str]] = {
    "CA": ("#E60012", "#FFFFFF"),
    "CZ": ("#0093D0", "#FFFFFF"),
    "MU": ("#005CA9", "#FFFFFF"),
    "HU": ("#E60012", "#FFFFFF"),
    "ZH": ("#E60012", "#FFFFFF"),
    "MF": ("#007CC3", "#FFFFFF"),
    "3U": ("#E60012", "#FFFFFF"),
    "9C": ("#00A651", "#FFFFFF"),
    "HO": ("#7B1FA2", "#FFFFFF"),
    "JD": ("#E60012", "#FFFFFF"),
    "UA": ("#002244", "#FFFFFF"),
    "AA": ("#002147", "#FFFFFF"),
    "DL": ("#C8102E", "#FFFFFF"),
    "LH": ("#0A1D3D", "#FFFFFF"),
    "BA": ("#00247D", "#FFFFFF"),
    "AF": ("#002157", "#FFFFFF"),
    "KL": ("#002F9F", "#FFFFFF"),
    "JL": ("#E60012", "#FFFFFF"),
    "NH": ("#003399", "#FFFFFF"),
    "KE": ("#0078D4", "#FFFFFF"),
    "CX": ("#006564", "#FFFFFF"),
    "SQ": ("#003366", "#FFFFFF"),
    "EK": ("#E60012", "#FFFFFF"),
    "QR": ("#5C0632", "#FFFFFF"),
    "TK": ("#E31E17", "#FFFFFF"),
}

for _airline in DEFAULT_AIRLINES:
    if _theme := _AIRLINE_THEME_COLORS.get(_airline["code"]):
        _airline.setdefault("brandColors", {"primary": _theme[0], "contrast": _theme[1]})

DEFAULT_AIRPORTS: list[dict[str, Any]] = [
    # 中国主要机场
    {"code": "PEK", "icao": "ZBAA", "nameZh": "北京首都", "nameEn": "Beijing Capital", "cityZh": "北京", "cityEn": "Beijing", "countryZh": "中国", "countryEn": "China", "terminals": ["T1", "T2", "T3"]},
    {"code": "PKX", "icao": "ZBAD", "nameZh": "北京大兴", "nameEn": "Beijing Daxing", "cityZh": "北京", "cityEn": "Beijing", "countryZh": "中国", "countryEn": "China", "terminals": ["T1"]},
    {"code": "SHA", "icao": "ZSSS", "nameZh": "上海虹桥", "nameEn": "Shanghai Hongqiao", "cityZh": "上海", "cityEn": "Shanghai", "countryZh": "中国", "countryEn": "China", "terminals": ["T1", "T2"]},
    {"code": "PVG", "icao": "ZSPD", "nameZh": "上海浦东", "nameEn": "Shanghai Pudong", "cityZh": "上海", "cityEn": "Shanghai", "countryZh": "中国", "countryEn": "China", "terminals": ["T1", "T2", "S1", "S2"]},
    {"code": "CAN", "icao": "ZGGG", "nameZh": "广州白云", "nameEn": "Guangzhou Baiyun", "cityZh": "广州", "cityEn": "Guangzhou", "countryZh": "中国", "countryEn": "China", "terminals": ["T1", "T2"]},
    {"code": "SZX", "icao": "ZGSZ", "nameZh": "深圳宝安", "nameEn": "Shenzhen Baoan", "cityZh": "深圳", "cityEn": "Shenzhen", "countryZh": "中国", "countryEn": "China", "terminals": ["T3"]},
    {"code": "CTU", "icao": "ZUUU", "nameZh": "成都双流", "nameEn": "Chengdu Shuangliu", "cityZh": "成都", "cityEn": "Chengdu", "countryZh": "中国", "countryEn": "China", "terminals": ["T1", "T2"]},
    {"code": "TFU", "icao": "ZUTF", "nameZh": "成都天府", "nameEn": "Chengdu Tianfu", "cityZh": "成都", "cityEn": "Chengdu", "countryZh": "中国", "countryEn": "China", "terminals": ["T1", "T2"]},
    {"code": "CKG", "icao": "ZUCK", "nameZh": "重庆江北", "nameEn": "Chongqing Jiangbei", "cityZh": "重庆", "cityEn": "Chongqing", "countryZh": "中国", "countryEn": "China", "terminals": ["T2", "T3A"]},
    {"code": "WUH", "icao": "ZHHH", "nameZh": "武汉天河", "nameEn": "Wuhan Tianhe", "cityZh": "武汉", "cityEn": "Wuhan", "countryZh": "中国", "countryEn": "China", "terminals": ["T2", "T3"]},
    {"code": "XIY", "icao": "ZLXY", "nameZh": "西安咸阳", "nameEn": "Xi'an Xianyang", "cityZh": "西安", "cityEn": "Xi'an", "countryZh": "中国", "countryEn": "China", "terminals": ["T1", "T2", "T3", "T5"]},
    {"code": "HGH", "icao": "ZSHC", "nameZh": "杭州萧山", "nameEn": "Hangzhou Xiaoshan", "cityZh": "杭州", "cityEn": "Hangzhou", "countryZh": "中国", "countryEn": "China", "terminals": ["T1", "T3", "T4"]},
    {"code": "NKG", "icao": "ZSNJ", "nameZh": "南京禄口", "nameEn": "Nanjing Lukou", "cityZh": "南京", "cityEn": "Nanjing", "countryZh": "中国", "countryEn": "China", "terminals": ["T1", "T2"]},
    {"code": "KMG", "icao": "ZPPP", "nameZh": "昆明长水", "nameEn": "Kunming Changshui", "cityZh": "昆明", "cityEn": "Kunming", "countryZh": "中国", "countryEn": "China", "terminals": ["T1"]},
    {"code": "XMN", "icao": "ZSAM", "nameZh": "厦门高崎", "nameEn": "Xiamen Gaoqi", "cityZh": "厦门", "cityEn": "Xiamen", "countryZh": "中国", "countryEn": "China", "terminals": ["T3", "T4"]},
    {"code": "HAK", "icao": "ZJHK", "nameZh": "海口美兰", "nameEn": "Haikou Meilan", "cityZh": "海口", "cityEn": "Haikou", "countryZh": "中国", "countryEn": "China", "terminals": ["T1", "T2"]},
    {"code": "SYX", "icao": "ZJSY", "nameZh": "三亚凤凰", "nameEn": "Sanya Phoenix", "cityZh": "三亚", "cityEn": "Sanya", "countryZh": "中国", "countryEn": "China", "terminals": ["T1", "T2"]},
    {"code": "TAO", "icao": "ZSQD", "nameZh": "青岛胶东", "nameEn": "Qingdao Jiaodong", "cityZh": "青岛", "cityEn": "Qingdao", "countryZh": "中国", "countryEn": "China", "terminals": ["T1"]},
    {"code": "DLC", "icao": "ZYTL", "nameZh": "大连周水子", "nameEn": "Dalian Zhoushuizi", "cityZh": "大连", "cityEn": "Dalian", "countryZh": "中国", "countryEn": "China", "terminals": ["T1"]},
    {"code": "CSX", "icao": "ZGHA", "nameZh": "长沙黄花", "nameEn": "Changsha Huanghua", "cityZh": "长沙", "cityEn": "Changsha", "countryZh": "中国", "countryEn": "China", "terminals": ["T1", "T2"]},
    # 欧洲主要枢纽
    {"code": "LHR", "icao": "EGLL", "nameZh": "伦敦希思罗", "nameEn": "London Heathrow", "cityZh": "伦敦", "cityEn": "London", "countryZh": "英国", "countryEn": "UK", "terminals": ["T2", "T3", "T4", "T5"]},
    {"code": "LGW", "icao": "EGKK", "nameZh": "伦敦盖特威克", "nameEn": "London Gatwick", "cityZh": "伦敦", "cityEn": "London", "countryZh": "英国", "countryEn": "UK", "terminals": ["N", "S"]},
    {"code": "CDG", "icao": "LFPG", "nameZh": "巴黎戴高乐", "nameEn": "Paris CDG", "cityZh": "巴黎", "cityEn": "Paris", "countryZh": "法国", "countryEn": "France", "terminals": ["T1", "T2A", "T2B", "T2C", "T2D", "T2E", "T2F", "T2G", "T3"]},
    {"code": "FRA", "icao": "EDDF", "nameZh": "法兰克福", "nameEn": "Frankfurt", "cityZh": "法兰克福", "cityEn": "Frankfurt", "countryZh": "德国", "countryEn": "Germany", "terminals": ["T1", "T2"]},
    {"code": "MUC", "icao": "EDDM", "nameZh": "慕尼黑", "nameEn": "Munich", "cityZh": "慕尼黑", "cityEn": "Munich", "countryZh": "德国", "countryEn": "Germany", "terminals": ["T1", "T2"]},
    {"code": "AMS", "icao": "EHAM", "nameZh": "阿姆斯特丹", "nameEn": "Amsterdam Schiphol", "cityZh": "阿姆斯特丹", "cityEn": "Amsterdam", "countryZh": "荷兰", "countryEn": "Netherlands", "terminals": ["T1"]},
    {"code": "FCO", "icao": "LIRF", "nameZh": "罗马菲乌米奇诺", "nameEn": "Rome Fiumicino", "cityZh": "罗马", "cityEn": "Rome", "countryZh": "意大利", "countryEn": "Italy", "terminals": ["T1", "T3"]},
    {"code": "MAD", "icao": "LEMD", "nameZh": "马德里巴拉哈斯", "nameEn": "Madrid Barajas", "cityZh": "马德里", "cityEn": "Madrid", "countryZh": "西班牙", "countryEn": "Spain", "terminals": ["T1", "T2", "T3", "T4", "T4S"]},
    {"code": "BCN", "icao": "LEBL", "nameZh": "巴塞罗那", "nameEn": "Barcelona", "cityZh": "巴塞罗那", "cityEn": "Barcelona", "countryZh": "西班牙", "countryEn": "Spain", "terminals": ["T1", "T2"]},
    {"code": "ZRH", "icao": "LSZH", "nameZh": "苏黎世", "nameEn": "Zurich", "cityZh": "苏黎世", "cityEn": "Zurich", "countryZh": "瑞士", "countryEn": "Switzerland", "terminals": ["A", "B/D", "E"]},
    {"code": "VIE", "icao": "LOWW", "nameZh": "维也纳", "nameEn": "Vienna", "cityZh": "维也纳", "cityEn": "Vienna", "countryZh": "奥地利", "countryEn": "Austria", "terminals": ["T1", "T2", "T3"]},
    {"code": "IST", "icao": "LTFM", "nameZh": "伊斯坦布尔", "nameEn": "Istanbul", "cityZh": "伊斯坦布尔", "cityEn": "Istanbul", "countryZh": "土耳其", "countryEn": "Turkey", "terminals": ["T1"]},
    {"code": "DUB", "icao": "EIDW", "nameZh": "都柏林", "nameEn": "Dublin", "cityZh": "都柏林", "cityEn": "Dublin", "countryZh": "爱尔兰", "countryEn": "Ireland", "terminals": ["T1", "T2"]},
    {"code": "CPH", "icao": "EKCH", "nameZh": "哥本哈根", "nameEn": "Copenhagen", "cityZh": "哥本哈根", "cityEn": "Copenhagen", "countryZh": "丹麦", "countryEn": "Denmark", "terminals": ["T2", "T3"]},
    {"code": "ARN", "icao": "ESSA", "nameZh": "斯德哥尔摩", "nameEn": "Stockholm Arlanda", "cityZh": "斯德哥尔摩", "cityEn": "Stockholm", "countryZh": "瑞典", "countryEn": "Sweden", "terminals": ["T2", "T5"]},
    {"code": "OSL", "icao": "ENGM", "nameZh": "奥斯陆", "nameEn": "Oslo", "cityZh": "奥斯陆", "cityEn": "Oslo", "countryZh": "挪威", "countryEn": "Norway", "terminals": ["T1"]},
    {"code": "HEL", "icao": "EFHK", "nameZh": "赫尔辛基", "nameEn": "Helsinki", "cityZh": "赫尔辛基", "cityEn": "Helsinki", "countryZh": "芬兰", "countryEn": "Finland", "terminals": ["T1", "T2"]},
    {"code": "LIS", "icao": "LPPT", "nameZh": "里斯本", "nameEn": "Lisbon", "cityZh": "里斯本", "cityEn": "Lisbon", "countryZh": "葡萄牙", "countryEn": "Portugal", "terminals": ["T1", "T2"]},
    {"code": "WAW", "icao": "EPWA", "nameZh": "华沙肖邦", "nameEn": "Warsaw Chopin", "cityZh": "华沙", "cityEn": "Warsaw", "countryZh": "波兰", "countryEn": "Poland", "terminals": ["A"]},
    {"code": "BRU", "icao": "EBBR", "nameZh": "布鲁塞尔", "nameEn": "Brussels", "cityZh": "布鲁塞尔", "cityEn": "Brussels", "countryZh": "比利时", "countryEn": "Belgium", "terminals": ["A", "B"]},
    {"code": "ATH", "icao": "LGAV", "nameZh": "雅典", "nameEn": "Athens", "cityZh": "雅典", "cityEn": "Athens", "countryZh": "希腊", "countryEn": "Greece", "terminals": ["T1"]},
    {"code": "SVO", "icao": "UUEE", "nameZh": "莫斯科谢列梅捷沃", "nameEn": "Moscow Sheremetyevo", "cityZh": "莫斯科", "cityEn": "Moscow", "countryZh": "俄罗斯", "countryEn": "Russia", "terminals": ["B", "C", "D", "E", "F"]},
    # 北美主要枢纽
    {"code": "ATL", "icao": "KATL", "nameZh": "亚特兰大", "nameEn": "Atlanta", "cityZh": "亚特兰大", "cityEn": "Atlanta", "countryZh": "美国", "countryEn": "US", "terminals": ["N", "S", "I"]},
    {"code": "LAX", "icao": "KLAX", "nameZh": "洛杉矶", "nameEn": "Los Angeles", "cityZh": "洛杉矶", "cityEn": "Los Angeles", "countryZh": "美国", "countryEn": "US", "terminals": ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "TB", "TBIT"]},
    {"code": "ORD", "icao": "KORD", "nameZh": "芝加哥奥黑尔", "nameEn": "Chicago O'Hare", "cityZh": "芝加哥", "cityEn": "Chicago", "countryZh": "美国", "countryEn": "US", "terminals": ["T1", "T2", "T3", "T5"]},
    {"code": "DFW", "icao": "KDFW", "nameZh": "达拉斯/沃思堡", "nameEn": "Dallas/Fort Worth", "cityZh": "达拉斯", "cityEn": "Dallas", "countryZh": "美国", "countryEn": "US", "terminals": ["A", "B", "C", "D", "E"]},
    {"code": "JFK", "icao": "KJFK", "nameZh": "纽约肯尼迪", "nameEn": "New York JFK", "cityZh": "纽约", "cityEn": "New York", "countryZh": "美国", "countryEn": "US", "terminals": ["T1", "T4", "T5", "T7", "T8"]},
    {"code": "EWR", "icao": "KEWR", "nameZh": "纽瓦克", "nameEn": "Newark", "cityZh": "纽约", "cityEn": "New York", "countryZh": "美国", "countryEn": "US", "terminals": ["A", "B", "C"]},
    {"code": "SFO", "icao": "KSFO", "nameZh": "旧金山", "nameEn": "San Francisco", "cityZh": "旧金山", "cityEn": "San Francisco", "countryZh": "美国", "countryEn": "US", "terminals": ["T1", "T2", "T3", "I"]},
    {"code": "SEA", "icao": "KSEA", "nameZh": "西雅图", "nameEn": "Seattle", "cityZh": "西雅图", "cityEn": "Seattle", "countryZh": "美国", "countryEn": "US", "terminals": ["A", "B", "C", "D", "N", "S"]},
    {"code": "MIA", "icao": "KMIA", "nameZh": "迈阿密", "nameEn": "Miami", "cityZh": "迈阿密", "cityEn": "Miami", "countryZh": "美国", "countryEn": "US", "terminals": ["N", "C", "S"]},
    {"code": "IAH", "icao": "KIAH", "nameZh": "休斯顿", "nameEn": "Houston IAH", "cityZh": "休斯顿", "cityEn": "Houston", "countryZh": "美国", "countryEn": "US", "terminals": ["A", "B", "C", "D", "E"]},
    {"code": "BOS", "icao": "KBOS", "nameZh": "波士顿", "nameEn": "Boston", "cityZh": "波士顿", "cityEn": "Boston", "countryZh": "美国", "countryEn": "US", "terminals": ["A", "B", "C", "E"]},
    {"code": "IAD", "icao": "KIAD", "nameZh": "华盛顿杜勒斯", "nameEn": "Washington Dulles", "cityZh": "华盛顿", "cityEn": "Washington", "countryZh": "美国", "countryEn": "US", "terminals": ["A", "B", "C", "D"]},
    {"code": "LAS", "icao": "KLAS", "nameZh": "拉斯维加斯", "nameEn": "Las Vegas", "cityZh": "拉斯维加斯", "cityEn": "Las Vegas", "countryZh": "美国", "countryEn": "US", "terminals": ["T1", "T3"]},
    {"code": "MCO", "icao": "KMCO", "nameZh": "奥兰多", "nameEn": "Orlando", "cityZh": "奥兰多", "cityEn": "Orlando", "countryZh": "美国", "countryEn": "US", "terminals": ["A", "B", "C"]},
    {"code": "CLT", "icao": "KCLT", "nameZh": "夏洛特", "nameEn": "Charlotte", "cityZh": "夏洛特", "cityEn": "Charlotte", "countryZh": "美国", "countryEn": "US", "terminals": ["A", "B", "C", "D", "E"]},
    {"code": "PHX", "icao": "KPHX", "nameZh": "菲尼克斯", "nameEn": "Phoenix", "cityZh": "菲尼克斯", "cityEn": "Phoenix", "countryZh": "美国", "countryEn": "US", "terminals": ["T2", "T3", "T4"]},
    {"code": "MSP", "icao": "KMSP", "nameZh": "明尼阿波利斯", "nameEn": "Minneapolis", "cityZh": "明尼阿波利斯", "cityEn": "Minneapolis", "countryZh": "美国", "countryEn": "US", "terminals": ["T1", "T2"]},
    {"code": "DEN", "icao": "KDEN", "nameZh": "丹佛", "nameEn": "Denver", "cityZh": "丹佛", "cityEn": "Denver", "countryZh": "美国", "countryEn": "US", "terminals": ["A", "B", "C"]},
    {"code": "YYZ", "icao": "CYYZ", "nameZh": "多伦多皮尔逊", "nameEn": "Toronto Pearson", "cityZh": "多伦多", "cityEn": "Toronto", "countryZh": "加拿大", "countryEn": "Canada", "terminals": ["T1", "T3"]},
    {"code": "YVR", "icao": "CYVR", "nameZh": "温哥华", "nameEn": "Vancouver", "cityZh": "温哥华", "cityEn": "Vancouver", "countryZh": "加拿大", "countryEn": "Canada", "terminals": ["I", "D"]},
    # 亚洲/中东主要枢纽
    {"code": "HND", "icao": "RJTT", "nameZh": "东京羽田", "nameEn": "Tokyo Haneda", "cityZh": "东京", "cityEn": "Tokyo", "countryZh": "日本", "countryEn": "Japan", "terminals": ["T1", "T2", "T3"]},
    {"code": "NRT", "icao": "RJAA", "nameZh": "东京成田", "nameEn": "Tokyo Narita", "cityZh": "东京", "cityEn": "Tokyo", "countryZh": "日本", "countryEn": "Japan", "terminals": ["T1", "T2", "T3"]},
    {"code": "ICN", "icao": "RKSI", "nameZh": "仁川", "nameEn": "Seoul Incheon", "cityZh": "首尔", "cityEn": "Seoul", "countryZh": "韩国", "countryEn": "South Korea", "terminals": ["T1", "T2"]},
    {"code": "SIN", "icao": "WSSS", "nameZh": "新加坡樟宜", "nameEn": "Singapore Changi", "cityZh": "新加坡", "cityEn": "Singapore", "countryZh": "新加坡", "countryEn": "Singapore", "terminals": ["T1", "T2", "T3", "T4"]},
    {"code": "HKG", "icao": "VHHH", "nameZh": "香港", "nameEn": "Hong Kong", "cityZh": "香港", "cityEn": "Hong Kong", "countryZh": "中国", "countryEn": "China", "terminals": ["T1"]},
    {"code": "BKK", "icao": "VTBS", "nameZh": "曼谷素万那普", "nameEn": "Bangkok Suvarnabhumi", "cityZh": "曼谷", "cityEn": "Bangkok", "countryZh": "泰国", "countryEn": "Thailand", "terminals": ["T1"]},
    {"code": "DXB", "icao": "OMDB", "nameZh": "迪拜", "nameEn": "Dubai", "cityZh": "迪拜", "cityEn": "Dubai", "countryZh": "阿联酋", "countryEn": "UAE", "terminals": ["T1", "T2", "T3"]},
    {"code": "DOH", "icao": "OTHH", "nameZh": "多哈哈马德", "nameEn": "Doha Hamad", "cityZh": "多哈", "cityEn": "Doha", "countryZh": "卡塔尔", "countryEn": "Qatar", "terminals": ["T1"]},
    {"code": "AUH", "icao": "OMAA", "nameZh": "阿布扎比", "nameEn": "Abu Dhabi", "cityZh": "阿布扎比", "cityEn": "Abu Dhabi", "countryZh": "阿联酋", "countryEn": "UAE", "terminals": ["A"]},
    {"code": "DEL", "icao": "VIDP", "nameZh": "新德里", "nameEn": "New Delhi", "cityZh": "新德里", "cityEn": "New Delhi", "countryZh": "印度", "countryEn": "India", "terminals": ["T1", "T2", "T3"]},
    {"code": "KUL", "icao": "WMKK", "nameZh": "吉隆坡", "nameEn": "Kuala Lumpur", "cityZh": "吉隆坡", "cityEn": "Kuala Lumpur", "countryZh": "马来西亚", "countryEn": "Malaysia", "terminals": ["T1", "T2"]},
]

DEFAULT_AIRCRAFT_TYPES: list[dict[str, Any]] = [
    {"icao": "A320", "iata": "320", "manufacturer": "Airbus (空客) FR", "displayName": "A320"},
    {"icao": "A20N", "iata": "32N", "manufacturer": "Airbus (空客) FR", "displayName": "A320neo"},
    {"icao": "A319", "iata": "319", "manufacturer": "Airbus (空客) FR", "displayName": "A319"},
    {"icao": "A19N", "iata": "31N", "manufacturer": "Airbus (空客) FR", "displayName": "A319neo"},
    {"icao": "A321", "iata": "321", "manufacturer": "Airbus (空客) FR", "displayName": "A321"},
    {"icao": "A21N", "iata": "21N", "manufacturer": "Airbus (空客) FR", "displayName": "A321neo"},
    {"icao": "A332", "iata": "332", "manufacturer": "Airbus (空客) FR", "displayName": "A330-200"},
    {"icao": "A333", "iata": "333", "manufacturer": "Airbus (空客) FR", "displayName": "A330-300"},
    {"icao": "A339", "iata": "339", "manufacturer": "Airbus (空客) FR", "displayName": "A330-900neo"},
    {"icao": "A359", "iata": "359", "manufacturer": "Airbus (空客) FR", "displayName": "A350-900"},
    {"icao": "A35K", "iata": "351", "manufacturer": "Airbus (空客) FR", "displayName": "A350-1000"},
    {"icao": "A388", "iata": "388", "manufacturer": "Airbus (空客) FR", "displayName": "A380-800"},
    {"icao": "A346", "iata": "346", "manufacturer": "Airbus (空客) FR", "displayName": "A340-600"},
    {"icao": "B738", "iata": "738", "manufacturer": "Boeing (波音) US", "displayName": "737-800"},
    {"icao": "B38M", "iata": "7M8", "manufacturer": "Boeing (波音) US", "displayName": "737 MAX 8"},
    {"icao": "B739", "iata": "739", "manufacturer": "Boeing (波音) US", "displayName": "737-900"},
    {"icao": "B39M", "iata": "7M9", "manufacturer": "Boeing (波音) US", "displayName": "737 MAX 9"},
    {"icao": "B772", "iata": "772", "manufacturer": "Boeing (波音) US", "displayName": "777-200"},
    {"icao": "B77W", "iata": "77W", "manufacturer": "Boeing (波音) US", "displayName": "777-300ER"},
    {"icao": "B77L", "iata": "77L", "manufacturer": "Boeing (波音) US", "displayName": "777-200LR"},
    {"icao": "B789", "iata": "789", "manufacturer": "Boeing (波音) US", "displayName": "787-9"},
    {"icao": "B788", "iata": "788", "manufacturer": "Boeing (波音) US", "displayName": "787-8"},
    {"icao": "B78X", "iata": "781", "manufacturer": "Boeing (波音) US", "displayName": "787-10"},
    {"icao": "B748", "iata": "748", "manufacturer": "Boeing (波音) US", "displayName": "747-8"},
    {"icao": "B744", "iata": "744", "manufacturer": "Boeing (波音) US", "displayName": "747-400"},
    {"icao": "C919", "iata": "919", "manufacturer": "COMAC (中国商飞) CN", "displayName": "C919"},
    {"icao": "ARJ2", "iata": "ARJ", "manufacturer": "COMAC (中国商飞) CN", "displayName": "ARJ21"},
    {"icao": "CRJ9", "iata": "CR9", "manufacturer": "Bombardier (庞巴迪) CA", "displayName": "CRJ900"},
    {"icao": "E170", "iata": "E70", "manufacturer": "Embraer (巴航工业) BR", "displayName": "E170"},
    {"icao": "E175", "iata": "E75", "manufacturer": "Embraer (巴航工业) BR", "displayName": "E175"},
    {"icao": "E190", "iata": "E90", "manufacturer": "Embraer (巴航工业) BR", "displayName": "E190"},
    {"icao": "E195", "iata": "E95", "manufacturer": "Embraer (巴航工业) BR", "displayName": "E195"},
    {"icao": "E295", "iata": "E95", "manufacturer": "Embraer (巴航工业) BR", "displayName": "E195-E2"},
    {"icao": "J328", "iata": "FRJ", "manufacturer": "Fairchild (仙童) US", "displayName": "Dornier 328 JET"},
    {"icao": "SW4", "iata": "SW4", "manufacturer": "Fairchild (仙童) US", "displayName": "Swearingen Metro 23"},
]
