const { runCategoryScraper } = require('./categoryScraper');
const { runSitemapScraper } = require("./sitemapScraper");


exports.categoryScraper = async ({ rubros = "4", pageDelay, categoryDelay }) => {
    return await runCategoryScraper({ rubros, pageDelay, categoryDelay });
};

exports.sitemapScraper = async () => {
    return await runSitemapScraper();
}