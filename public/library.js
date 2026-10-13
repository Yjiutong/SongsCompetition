// 预制曲库：按歌手整理，添加歌曲时可直接挑选，省去手输。
// 纯数据文件，不参与游戏逻辑；需要更多歌手时往 SONG_LIBRARY 里加即可。
const SONG_LIBRARY = {
  周杰伦: ["晴天", "七里香", "稻香", "夜曲", "青花瓷", "简单爱", "告白气球", "搁浅", "以父之名", "听妈妈的话"],
  林俊杰: ["江南", "可惜没有如果", "修炼爱情", "那些你很冒险的梦", "不为谁而作的歌", "她说", "醉赤壁", "记住我"],
  陈奕迅: ["十年", "富士山下", "浮夸", "稳稳的幸福", "K歌之王", "你的背包", "孤勇者", "最佳损友"],
  孙燕姿: ["遇见", "天黑黑", "我不难过", "开始懂了", "逆光", "绿光", "逃亡", "当冬夜渐暖"],
  刘若英: ["后来", "很爱很爱你", "成全", "为爱痴狂", "一辈子的孤单", "继续", "亲爱的路人"],
  王菲: ["红豆", "我愿意", "容易受伤的女人", "匆匆那年", "致青春", "天空", "传奇", "暧昧"],
  朴树: ["平凡之路", "那些花儿", "生如夏花", "白桦林", "旅途", "在希望的田野上"],
  Beyond: ["海阔天空", "光辉岁月", "不再犹豫", "喜欢你", "真的爱你", "大地"],
  周华健: ["朋友", "刀剑如梦", "花心", "让我欢喜让我忧", "亲亲我的宝贝", "难念的经"],
  蔡依林: ["日不落", "舞娘", "说爱你", "倒带", "爱情三十六计", "布拉格广场", "天空"],
  "S.H.E": ["Super Star", "恋人未满", "中国话", "热带雨林", "你曾是少年", "不想长大"],
  五月天: ["突然好想你", "倔强", "温柔", "知足", "后来的我们", "拥抱", "恋爱ing", "干杯"],
  薛之谦: ["演员", "丑八怪", "认真的雪", "天外来物", "刚刚好", "意外", "方圆几里"],
  邓紫棋: ["泡沫", "光年之外", "喜欢你", "句号", "倒数", "多远都要在一起", "后会无期"],
  毛不易: ["消愁", "像我这样的人", "平凡的一天", "牧马城市", "借", "盛夏"],
  李荣浩: ["李白", "模特", "年少有为", "不将就", "喜剧之王", "乌梅子酱", "戒烟"],
  赵雷: ["成都", "南方姑娘", "画", "理想", "三十岁的女人", "我们的时光"],
  张国荣: ["倩女幽魂", "风继续吹", "沉默是金", "当爱已成往事", "我", "Monica"],
  梅艳芳: ["女人花", "似是故人来", "夕阳之歌", "亲密爱人", "一生爱你千百回"],
  张学友: ["吻别", "祝福", "如果这都不算爱", "忘情冷雨夜", "一千个伤心的理由", "每天爱你多一些"],
  刘德华: ["忘情水", "冰雨", "今天", "男人哭吧不是罪", "谢谢你", "十七岁"],
  罗大佑: ["童年", "光阴的故事", "恋曲1990", "你的样子", "东方之珠", "野百合也有春天"],
  邓丽君: ["月亮代表我的心", "甜蜜蜜", "小城故事", "我只在乎你", "但愿人长久", "路边的野花不要采"],
  周传雄: ["黄昏", "寂寞沙洲冷", "男人海洋", "记事本", "我的心太乱", "冬天的秘密"],
  陶喆: ["就是爱你", "爱很简单", "今天你要嫁给我", "黑色柳丁", "小镇姑娘", "普通朋友"],
  王力宏: ["唯一", "心中的日月", "大城小爱", "我们的歌", "改变自己", "需要人陪"],
  蔡健雅: ["陌生人", "红色高跟鞋", "被驯服的象", "别找我麻烦", "停格", "Beautiful Love"],
  田馥甄: ["小幸运", "魔鬼中的天使", "寂寞寂寞就好", "你就不要想起我", "小王子"],
  华晨宇: ["烟火里的尘埃", "国王与乞丐", "好想爱这个世界啊", "齐天", "我管你"],
  陈粒: ["奇妙能力歌", "小半", "走马", "易燃易爆炸", "光", "历历万乡"],
  万能青年旅店: ["杀死那个石家庄人", "秦皇岛", "山雀", "揪心的玩笑与漫长的白日梦"],
  告五人: ["爱人错过", "披星戴月的想你", "唯一", "运气来得若有似无"],
  茄子蛋: ["浪子回头", "浪流连", "这款自作多情"],
  BillieEilish: ["bad guy", "lovely", "when the party's over", "everything i wanted", "ocean eyes"],
  TaylorSwift: ["Love Story", "Blank Space", "Shake It Off", "Cruel Summer", "Enchanted", "Lover"],
  EdSheeran: ["Shape of You", "Perfect", "Thinking Out Loud", "Photograph", "Castle on the Hill"],
  Maroon5: ["Sugar", "Payphone", "Memories", "Moves Like Jagger", "Girls Like You"],
  Adele: ["Someone Like You", "Hello", "Rolling in the Deep", "Easy on Me", "Set Fire to the Rain"],
  Coldplay: ["Yellow", "Viva la Vida", "Fix You", "A Sky Full of Stars", "The Scientist"],
  Queen: ["Bohemian Rhapsody", "We Will Rock You", "Love of My Life", "Don't Stop Me Now"],
  MichaelJackson: ["Billie Jean", "Beat It", "Heal the World", "You Are Not Alone", "Thriller"],
  BrunoMars: ["Just the Way You Are", "Grenade", "Uptown Funk", "When I Was Your Man", "Talking to the Moon"],
  TheWeeknd: ["Blinding Lights", "Starboy", "Save Your Tears", "Die For You"],
  ImagineDragons: ["Believer", "Radioactive", "Demons", "Thunder", "Natural"],
  OneRepublic: ["Counting Stars", "Apologize", "Secrets", "I Ain't Worried"],
  Passenger: ["Let Her Go", "Scare Away the Dark"],
  PostMalone: ["Circles", "Sunflower", "Wow."],
  CharliePuth: ["Attention", "We Don't Talk Anymore", "See You Again", "One Call Away"],
};

// 派生索引：{artist, title} 平表，供搜索用
const SONG_LIBRARY_FLAT = [];
for (const artist of Object.keys(SONG_LIBRARY)) {
  for (const title of SONG_LIBRARY[artist]) {
    SONG_LIBRARY_FLAT.push({ artist, title });
  }
}
