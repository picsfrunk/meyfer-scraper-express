const { runCategoryScraper } = require('./categoryScraper');
const { runSitemapScraper } = require("./sitemapScraper");


exports.runCategoryScraper = async ({ rubros = "4", pageDelay, categoryDelay }) => {
    return await runCategoryScraper({ rubros, pageDelay, categoryDelay });
};

exports.runSitemapScraper = async () => {
    return await runSitemapScraper();
}