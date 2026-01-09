# Arona-AI-Pet

BA阿罗娜的LLM桌宠，demo级实现，仅供学习交流，请自备OpenAI Compatible API

[spine来源](https://github.com/Apis035/bluearchive-spine)

[角色设定来源](https://github.com/Zao-chen/ZcChat/discussions/79)

心情我自己标的，太多了没标全，而且不一定准

```json
{
    "正常": "00",
    "私语": "02",
    "开心": "03",
    "不淡定": "04",
    "生气": "05",
    "难过": "06",
    "又羞又急": "07",
    "腹黑": "08",
    "心虚": "09",
    "不想评价": "10",
    "爱你": "11",
    "兴奋": "12",
    "欣慰": "13",
    "无语": "14",
    "害羞": "15",
    "惊讶": "16",
    "惊慌": "17",
    "不要啊": "18",
    "有点开心": "20",
    "看到宝了": "21",
    "干劲十足": "22",
    "困": "23",
    "超元气": "25",
    "完蛋了": "28",
    "晕": "29"
}
```

输出格式记得加一句You should reply only one mood, one Chinese sentence and one Japanese sentence.（默认设置已经加了）如果回复格式有误就处理不了。

没有语音功能，但是有日语输出，想加语音可以自己尝试

有个图标在托盘区，设置请右键该图标

![](git_assets/bad.png)
![](git_assets/ok.png)

## 构建

```bash
npm run tauri build
```

随缘更新