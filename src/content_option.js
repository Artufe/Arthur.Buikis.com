const logotext = "ArtDev";
const meta = {
    title: "Arthur Buikis",
    description: "Hi, I’m Art - Full stack developer, Data Engineer, Devops expert",
};

const introdata = {
    title: "I’m Arthur",
    animated: {
        first: "I love python",
        second: "I develop solutions",
        third: "I code cool websites",
    },
    description: "Problem solving is my passion and RedBull is my spirit animal.",
    your_img_url: "https://d2jqrm6oza8nb6.cloudfront.net/previews/c2acbb51-0e05-485d-b0b4-40a708f5a42c.jpg?_jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJrZXlIYXNoIjoiZDQ1ZmU4ODY1OTJlZGUxZSIsImJ1Y2tldCI6InJ1bndheS1kYXRhc2V0cyIsInN0YWdlIjoicHJvZCIsImV4cCI6MTcwODM4NzIwMH0.rwbV7Pm5Ns8PDXYjDUC-tK5yGGiOUljX1b5psGRlzhA",
};

const dataabout = {
    title: "My Background",
    aboutme: "Born in Latvia, I did not get my first computer untill the age of 14. Sharing family computer became a thing of the past, and so did the outside world. Starting with static websites, light hacking and minecraft server hosting, I expanded my knowledge of the inner workings of many systems. Faced with the harsh reality of life after finishing school, I began self learning programming. Starting with python, I slowly built up the skill to start creating projects for others on UpWork. After a company hiring me from a UpWork job, I began expanding my skillset in the real world, by working on and developing solutions. Currently between jobs, I am on a self-improvement journey, and quest to build my own product platform.",
};
const worktimeline = [{
        jobtitle: "Designer of week",
        where: "YAdfi",
        date: "2020",
    },
    {
        jobtitle: "Designer of week",
        where: "Jamalya",
        date: "2019",
    },
    {
        jobtitle: "Designer of week",
        where: "ALquds",
        date: "2019",
    },
];

const skills = [{
        name: "Python",
        value: 90,
    },
    {
        name: "Django",
        value: 85,
    },
    {
        name: "React",
        value: 60,
    },
    {
        name: "Vue",
        value: 70,
    },
    {
        name: "Jquery",
        value: 85,
    },
    {
        name: "Docker",
        value: 90,
    },
];

const services = [{
        title: "API Development and Design",
        description: "Have data, or you need to create a custom solution using APIs/Webhooks/Queues etc? I grasp that and I will be able to create the right solution for you.",
    },
    {
        title: "Full stack solutions",
        description: "If you require a custom solution, tailored to your business needs, I will be able to create the right solution for you.",
    },
    {
        title: "Consultations",
        description: "Stuck in a neverending technological nightmare? I can offer advice to make it happen.",
    },
];

const dataportfolio = [{
        img: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d2/Upwork-logo.svg/2560px-Upwork-logo.svg.png",
        description: "5+ projects completed on UpWork",
    },
    {
        img: "https://m.media-amazon.com/images/I/51uutgaGl8L.png",
        description: "Mobile 4G proxies, using your own mobile phone. Proxy Sale/Rental/Geo Targeting platform",
        link: "https://www.my-proxy.com/",
    },
    {
        img: "https://d2jqrm6oza8nb6.cloudfront.net/previews/c2acbb51-0e05-485d-b0b4-40a708f5a42c.jpg?_jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJrZXlIYXNoIjoiZDQ1ZmU4ODY1OTJlZGUxZSIsImJ1Y2tldCI6InJ1bndheS1kYXRhc2V0cyIsInN0YWdlIjoicHJvZCIsImV4cCI6MTcwODM4NzIwMH0.rwbV7Pm5Ns8PDXYjDUC-tK5yGGiOUljX1b5psGRlzhA",
        description: "My personal website, built with React.",
        link: "https://artufe.github.io/",
    },
    {
        img: "https://static.vecteezy.com/system/resources/previews/022/910/400/original/btb-letter-logo-design-in-illustration-logo-calligraphy-designs-for-logo-poster-invitation-etc-vector.jpg",
        description: "Bravo Tango Bravo is a B2B lead generation application, for finding relevant leads in specific areas.",
        link: "https://github.com/Artufe/bravo-tango-bravo",
    },
    {
        img: "https://i0.wp.com/www.manifest.co.uk/wp-content/uploads/2020/03/companies-house.jpg?fit=900%2C900&ssl=1",
        description: "Companies House (UK) Scraper. A solution for extracting data from the companies house using the streaming API.",
        link: "https://github.com/Artufe/CH-Streaming-API",
    },
    {
        img: "data:image/jpeg;base64,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",
        description: "Minecraft unique and short name finding tool",
        link: "https://github.com/Artufe/MC-Name-Finder",
    },
];

const contactConfig = {
    YOUR_EMAIL: "abuikis@gmail.com",
    YOUR_FONE: "+371 27848052",
    description: "",
    // creat an emailjs.com account 
    // check out this tutorial https://www.emailjs.com/docs/examples/reactjs/
    YOUR_SERVICE_ID: "service_1kmkqll",
    YOUR_TEMPLATE_ID: "template_hs71nnn",
    YOUR_USER_ID: "g7vSW5LNE5vXwMdI2",
};

const socialprofils = {
    github: "https://github.com/Artufe",
    facebook: "https://www.facebook.com/arturs.buikis/",
    linkedin: "https://www.linkedin.com/in/arthur-buikis-002145151/",
    twitter: "https://twitter.com",
};
export {
    meta,
    dataabout,
    dataportfolio,
    worktimeline,
    skills,
    services,
    introdata,
    contactConfig,
    socialprofils,
    logotext,
};